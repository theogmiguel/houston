//! The remote listener's HTTPS: a local certificate authority (key in the OS
//! keychain, certificate in settings) signs a server certificate at each listener
//! start, so a device trusts it once whatever the address. See docs/internals/overview.md.
use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, GeneralSubtree, IsCa, Issuer, KeyPair, KeyUsagePurpose,
    NameConstraints, SanType, SerialNumber,
};
use sha2::{Digest, Sha256};
use tokio_rustls::rustls;
use tokio_rustls::rustls::sign::CertifiedKey;
use zeroize::Zeroizing;

const KEY_ENTRY: &str = "ca-key";
pub(crate) const KEY_CA_CERT: &str = "remote_ca_cert";
pub(crate) const KEY_CA_NAME: &str = "remote_ca_name";

// Long enough that a device trusts it once; a regeneration replaces it sooner.
const CA_VALIDITY_DAYS: i64 = 3650;
// Under the 398 days Apple accepts for a server certificate; reissued at every listener start.
const SERVER_VALIDITY_DAYS: i64 = 397;

/// What the authority may sign: private and loopback addresses and `.local`
/// names. A leaked key could not impersonate a public site to a device that
/// trusts it.
fn permitted_subtrees() -> Vec<GeneralSubtree> {
    vec![
        GeneralSubtree::IpAddress(CidrSubnet::from_v4_prefix([10, 0, 0, 0], 8)),
        GeneralSubtree::IpAddress(CidrSubnet::from_v4_prefix([172, 16, 0, 0], 12)),
        GeneralSubtree::IpAddress(CidrSubnet::from_v4_prefix([192, 168, 0, 0], 16)),
        GeneralSubtree::IpAddress(CidrSubnet::from_v4_prefix([127, 0, 0, 0], 8)),
        GeneralSubtree::IpAddress(CidrSubnet::from_v6_prefix(
            [0xfc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            7,
        )),
        GeneralSubtree::IpAddress(CidrSubnet::from_v6_prefix(
            std::net::Ipv6Addr::LOCALHOST.octets(),
            128,
        )),
        GeneralSubtree::DnsName("local".to_string()),
        GeneralSubtree::DnsName("localhost".to_string()),
    ]
}

/// Whether the authority may name `host` (a `Host`-style name: brackets around IPv6).
pub fn covers(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => a.is_private() || a.is_loopback(),
        Ok(IpAddr::V6(a)) => a.is_loopback() || (a.octets()[0] & 0xfe) == 0xfc,
        Err(_) => {
            let name = bare.to_ascii_lowercase();
            name == "localhost" || (name.ends_with(".local") && name.len() > ".local".len())
        }
    }
}

fn days(n: i64) -> time::Duration {
    time::Duration::days(n)
}

fn random_serial() -> SerialNumber {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    bytes[0] &= 0x7f;
    SerialNumber::from_slice(&bytes)
}

fn ca_params(name: &str) -> CertificateParams {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, name);
    dn.push(DnType::OrganizationName, "Houston");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.name_constraints = Some(NameConstraints {
        permitted_subtrees: permitted_subtrees(),
        excluded_subtrees: Vec::new(),
    });
    params
}

/// The local certificate authority. Its key never leaves this process and the keychain.
pub struct Authority {
    name: String,
    cert_der: Vec<u8>,
    cert_pem: String,
    key: KeyPair,
}

impl Authority {
    /// A new authority, named so that two installations are told apart on a device.
    pub fn generate(host_label: &str) -> Result<Self> {
        let mut suffix = [0u8; 4];
        rand::fill(&mut suffix);
        let label: String = host_label
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(32)
            .collect();
        let name = format!(
            "Houston local CA {} {:02x}{:02x}{:02x}{:02x}",
            if label.is_empty() { "computer" } else { &label },
            suffix[0],
            suffix[1],
            suffix[2],
            suffix[3]
        );
        let key = KeyPair::generate().context("generating the certificate authority's key")?;
        let mut params = ca_params(&name);
        let now = time::OffsetDateTime::now_utc();
        params.not_before = now - days(1);
        params.not_after = now + days(CA_VALIDITY_DAYS);
        params.serial_number = Some(random_serial());
        let cert = params
            .self_signed(&key)
            .context("signing the certificate authority's certificate")?;
        Ok(Self {
            name,
            cert_der: cert.der().to_vec(),
            cert_pem: cert.pem(),
            key,
        })
    }

    /// The authority as stored: its name and certificate from the settings table,
    /// its key from the keychain.
    pub fn from_parts(name: &str, cert_pem: &str, key_pem: &str) -> Result<Self> {
        let key = KeyPair::from_pem(key_pem)
            .context("the certificate authority's key in the keychain is not a PEM key")?;
        let der = rustls::pki_types::pem::PemObject::from_pem_slice(cert_pem.as_bytes())
            .map(|c: rustls::pki_types::CertificateDer<'static>| c.to_vec())
            .map_err(|e| {
                anyhow!("the stored certificate authority is not a PEM certificate: {e}")
            })?;
        Ok(Self {
            name: name.to_string(),
            cert_der: der,
            cert_pem: cert_pem.to_string(),
            key,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn cert_der(&self) -> &[u8] {
        &self.cert_der
    }

    pub fn cert_pem(&self) -> &str {
        &self.cert_pem
    }

    pub fn key_pem(&self) -> Zeroizing<String> {
        Zeroizing::new(self.key.serialize_pem())
    }

    /// SHA-256 of the certificate, as devices show it: uppercase hex pairs.
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.cert_der)
    }

    /// A fresh server key and certificate for `hosts`, keeping only names the
    /// authority may sign. Errors when none is left.
    pub fn server_key(&self, hosts: &[String]) -> Result<Arc<CertifiedKey>> {
        let mut names: Vec<SanType> = Vec::new();
        for host in hosts.iter().filter(|h| covers(h)) {
            let bare = host.trim_start_matches('[').trim_end_matches(']');
            let san = match bare.parse::<IpAddr>() {
                Ok(ip) => SanType::IpAddress(ip),
                Err(_) => SanType::DnsName(
                    bare.to_string()
                        .try_into()
                        .with_context(|| format!("{bare:?} is not a DNS name"))?,
                ),
            };
            if !names.contains(&san) {
                names.push(san);
            }
        }
        if names.is_empty() {
            anyhow::bail!(
                "no address of this listener can be certified: the certificate covers private \
                 and loopback addresses and .local names, and the listener has only {hosts:?}"
            );
        }
        let key = KeyPair::generate().context("generating the server key")?;
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "Houston remote access");
        params.distinguished_name = dn;
        params.subject_alt_names = names;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        let now = time::OffsetDateTime::now_utc();
        params.not_before = now - days(1);
        params.not_after = now + days(SERVER_VALIDITY_DAYS);
        params.serial_number = Some(random_serial());
        let issuer = Issuer::new(ca_params(&self.name), &self.key);
        let cert = params
            .signed_by(&key, &issuer)
            .context("signing the server certificate")?;
        let chain = vec![
            cert.der().clone(),
            rustls::pki_types::CertificateDer::from(self.cert_der.clone()),
        ];
        let private = rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into());
        let signing = rustls::crypto::aws_lc_rs::sign::any_supported_type(&private)
            .context("loading the server key")?;
        Ok(Arc::new(CertifiedKey::new(chain, signing)))
    }

    /// An iOS configuration profile that installs the authority's certificate.
    /// Unsigned: iOS labels it "Not Signed", and full trust is a separate switch.
    pub fn mobileconfig(&self) -> String {
        use base64::Engine as _;
        let digest = Sha256::digest(&self.cert_der);
        let uuid = |salt: u8| {
            let mut b = [0u8; 16];
            b.copy_from_slice(&digest[..16]);
            b[0] ^= salt;
            uuid::Builder::from_random_bytes(b)
                .into_uuid()
                .hyphenated()
                .to_string()
                .to_uppercase()
        };
        let data = base64::engine::general_purpose::STANDARD.encode(&self.cert_der);
        let name = xml_escape(&self.name);
        let (outer, inner) = (uuid(0x00), uuid(0x5a));
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>houston-ca.cer</string>
      <key>PayloadContent</key>
      <data>{data}</data>
      <key>PayloadDescription</key>
      <string>Lets this device open Houston's remote access over HTTPS.</string>
      <key>PayloadDisplayName</key>
      <string>{name}</string>
      <key>PayloadIdentifier</key>
      <string>houston.remote.ca.{inner}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>{inner}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>The certificate authority of the Houston app on one of your computers. It can only certify private network addresses and .local names.</string>
  <key>PayloadDisplayName</key>
  <string>{name}</string>
  <key>PayloadIdentifier</key>
  <string>houston.remote.{outer}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>{outer}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
"#
        )
    }
}

/// The listener's current certificate. Replacing it reaches new handshakes at
/// once, so a new address or authority never restarts the listener.
#[derive(Debug)]
pub struct ServerCert(std::sync::RwLock<Arc<CertifiedKey>>);

impl ServerCert {
    pub fn new(key: Arc<CertifiedKey>) -> Arc<Self> {
        Arc::new(Self(std::sync::RwLock::new(key)))
    }

    pub fn set(&self, key: Arc<CertifiedKey>) {
        *self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = key;
    }

    pub fn server_config(self: &Arc<Self>) -> Result<Arc<rustls::ServerConfig>> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let mut config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .context("choosing TLS versions")?
            .with_no_client_auth()
            .with_cert_resolver(Arc::clone(self) as Arc<dyn rustls::server::ResolvesServerCert>);
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    }
}

impl rustls::server::ResolvesServerCert for ServerCert {
    fn resolve(&self, _hello: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(Arc::clone(
            &self
                .0
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        ))
    }
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// The fingerprint of a stored authority certificate, read without its key.
pub fn fingerprint_of_pem(pem: &str) -> Option<String> {
    let der: rustls::pki_types::CertificateDer<'static> =
        rustls::pki_types::pem::PemObject::from_pem_slice(pem.as_bytes()).ok()?;
    Some(fingerprint(&der))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// One keychain service per state directory, as for the ntfy topic, so a
/// development daemon never reads or replaces the installed one's authority.
fn entry(state_dir: &Path) -> Result<keyring::Entry> {
    keyring::Entry::new(
        &crate::keychain::scoped_service("houston-remote", state_dir),
        KEY_ENTRY,
    )
    .map_err(|e| anyhow!("opening the OS keychain for the certificate authority's key: {e}"))
}

pub fn store_key(state_dir: &Path, pem: &str) -> Result<()> {
    entry(state_dir)?
        .set_password(pem)
        .map_err(|e| anyhow!("storing the certificate authority's key in the OS keychain: {e}"))
}

pub fn load_key(state_dir: &Path) -> Result<Option<Zeroizing<String>>> {
    match entry(state_dir)?.get_password() {
        Ok(pem) => Ok(Some(Zeroizing::new(pem))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!(
            "reading the certificate authority's key from the OS keychain: {e}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_authority_covers_private_addresses_and_local_names_only() {
        for host in [
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.5",
            "192.168.1.20",
            "[::1]",
            "[fd12::1]",
            "localhost",
            "box.local",
        ] {
            assert!(covers(host), "{host} should be covered");
        }
        for host in [
            "8.8.8.8",
            "100.64.0.2",
            "172.32.0.1",
            "[2001:db8::1]",
            "example.com",
            "local",
            "box.ts.net",
        ] {
            assert!(!covers(host), "{host} must not be covered");
        }
    }

    #[test]
    fn a_stored_authority_signs_certificates_a_client_verifies() {
        let ca = Authority::generate("test-box").unwrap();
        let again = Authority::from_parts(ca.name(), ca.cert_pem(), &ca.key_pem()).unwrap();
        assert_eq!(again.fingerprint(), ca.fingerprint());
        assert_eq!(
            fingerprint_of_pem(ca.cert_pem()).as_deref(),
            Some(ca.fingerprint().as_str())
        );
        assert_eq!(again.cert_der(), ca.cert_der());
        assert_eq!(ca.fingerprint().len(), 32 * 3 - 1);
        let key = again
            .server_key(&["127.0.0.1".to_string(), "example.com".to_string()])
            .unwrap();
        assert_eq!(
            key.cert.len(),
            2,
            "the server certificate, then the authority"
        );
        assert_eq!(key.cert[1].as_ref(), ca.cert_der());
        let config = ServerCert::new(key).server_config().unwrap();
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn a_listener_with_no_coverable_address_is_refused_by_name() {
        let ca = Authority::generate("x").unwrap();
        let err = ca
            .server_key(&["example.com".to_string()])
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("example.com") && err.contains(".local"),
            "{err}"
        );
    }

    #[test]
    fn the_ios_profile_carries_the_certificate_as_a_root_payload() {
        use base64::Engine as _;
        let ca = Authority::generate("x").unwrap();
        let profile = ca.mobileconfig();
        assert!(profile.contains("<string>com.apple.security.root</string>"));
        assert!(profile.contains(&base64::engine::general_purpose::STANDARD.encode(ca.cert_der())));
        assert!(profile.contains(ca.name()));
    }
}
