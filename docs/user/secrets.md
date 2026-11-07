# Secrets

Houston can read credentials from a secret provider, so the credential stays in your password
manager and Houston saves only a reference to it. Agents can also ask you for a secret in a
private card instead of in the chat.

The Secrets settings page is in preview and is not in every build yet. Secret requests from agents
work everywhere.

## Secret providers

1Password is the supported provider. Houston reads secrets with the
[1Password CLI](https://developer.1password.com/docs/cli/) (`op`), so `op` must be installed and
signed in on the machine that runs the Houston server. When you use Houston on another machine or
from your phone, that is the remote machine, not the device in front of you.

To add one, open **Settings → Secrets**, select **Add provider**, and enter a name and the
1Password account: the shorthand, sign-in address (without `https://`), or ID that
`op account list` shows. Secret providers belong to the environment you are connected to. Each
environment keeps its own list.

## Use a secret reference

Credential fields in Settings, such as provider environment variables, provider credentials and
source control tokens, show a source picker next to the field.
Pick **Value** to save the credential itself, or pick a secret provider and enter a reference such
as `op://vault/item/field`. Copy the reference from 1Password with **Copy Secret Reference**.

Houston reads the secret when it needs it, for example when a provider starts. Change the
credential in 1Password and refresh to use the new value.

## When a secret cannot be read

If 1Password is locked or signed out, the provider or feature that needs the secret shows an error
naming the secret provider. Unlock 1Password on the server's machine, then select **Refresh** in
**Settings → Providers**. Houston never replaces a saved credential it cannot read with another
login.

## Remove a secret provider

Removing a secret provider in **Settings → Secrets** leaves the fields that read from it without a
secret, so set them again before you need them. The secrets in 1Password are not touched.

## When an agent asks for a secret

An agent that needs a token or password shows a secret request card in the thread instead of asking
you to paste it into the chat. Type or paste the value and select **Save securely**, or select
**Decline**. You can answer from the desktop app or the web interface.

If the environment has a secret provider, the card also lets you pick it and enter a reference
instead of the value. Houston reads the secret once, when you answer. If 1Password is locked, the
card says so and the request stays open: unlock it and try again, or enter the value.

The value never appears in the conversation. Most requests keep it from the agent too: Houston
passes it to the tool that needs it. When an agent has to run a command with the value, the card
says so instead: the value goes into a private file that the agent's commands can read for about 24
hours.
