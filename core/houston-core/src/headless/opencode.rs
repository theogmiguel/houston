use super::acp::AcpEngine;
use super::{Decoded, HeadlessEngine, PendingQuestion, TurnRequest};
use anyhow::Result;
use houston_protocol as proto;

pub struct OpencodeEngine(AcpEngine);

impl Default for OpencodeEngine {
    fn default() -> Self {
        let agent = crate::acp::find_known_acp_agent("acp-opencode")
            .expect("acp-opencode is a row in acp::KNOWN_ACP_AGENTS");
        OpencodeEngine(AcpEngine::new(agent))
    }
}

impl HeadlessEngine for OpencodeEngine {
    fn support(&self) -> super::EngineSupport {
        crate::headless::shared::engine_support(proto::AgentKind::Opencode)
    }

    fn program(&self) -> &str {
        self.0.program()
    }

    fn argv(&self, req: &TurnRequest) -> Result<Vec<String>> {
        self.0.argv(req)
    }

    fn stdin(&self, req: &TurnRequest) -> Option<String> {
        self.0.stdin(req)
    }

    fn decode(&mut self, line: &str) -> Vec<Decoded> {
        self.0.decode(line)
    }

    fn reply(&self, question: &PendingQuestion, answer: &str) -> Option<String> {
        self.0.reply(question, answer)
    }

    fn outbound(&mut self) -> Vec<String> {
        self.0.outbound()
    }

    fn stdin_stays_open(&self) -> bool {
        self.0.stdin_stays_open()
    }
}
