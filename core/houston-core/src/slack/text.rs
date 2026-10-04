//! Houston's own words in Slack, in the connector's language: fixed labels,
//! the owner's direct messages and notices no agent is there to write. What
//! the requester reads about the work itself comes from the agent.

use houston_protocol::SlackLanguage;

#[derive(Debug, Clone, Copy)]
pub struct Text(pub SlackLanguage);

impl Text {
    fn pick(self, pt: &'static str, en: &'static str) -> &'static str {
        match self.0 {
            SlackLanguage::PtBr => pt,
            SlackLanguage::En => en,
        }
    }

    fn pt(self) -> bool {
        self.0 == SlackLanguage::PtBr
    }

    pub fn accept(self) -> &'static str {
        self.pick("Aceitar", "Accept")
    }

    pub fn refuse(self) -> &'static str {
        self.pick("Recusar", "Refuse")
    }

    pub fn cancel(self) -> &'static str {
        self.pick("Cancelar", "Cancel")
    }

    pub fn view_message(self) -> &'static str {
        self.pick("Ver mensagem", "View message")
    }

    /// "*New request* in #channel, from @someone".
    pub fn new_request(self, channel: &str, author: &str) -> String {
        if self.pt() {
            format!("*Novo pedido* em <#{channel}>, de <@{author}>")
        } else {
            format!("*New request* in <#{channel}>, from <@{author}>")
        }
    }

    /// How a request is named before the agent has given it a subject.
    pub fn request_of(self, channel: &str, author: &str) -> String {
        if self.pt() {
            format!("o pedido de <@{author}> em <#{channel}>")
        } else {
            format!("the request from <@{author}> in <#{channel}>")
        }
    }

    /// What accepting would do now, given the working runs and the cap.
    pub fn start_outlook(self, working: usize, cap: usize) -> String {
        match (self.pt(), working) {
            (true, 0) => "nenhum trabalho em andamento, começa na hora".into(),
            (false, 0) => "nothing else is working; it starts right away".into(),
            (true, n) if n < cap => format!("{n} em andamento, começa na hora"),
            (false, n) if n < cap => format!("{n} working; it starts right away"),
            (true, n) => format!("{n} em andamento (limite {cap}); entra na fila"),
            (false, n) => format!("{n} working (limit {cap}); it joins the queue"),
        }
    }

    pub fn accepted_started(self) -> &'static str {
        self.pick("Aceito · começou", "Accepted · started")
    }

    pub fn accepted_queued(self, position: usize) -> String {
        if self.pt() {
            format!("Aceito · na fila, posição {position}")
        } else {
            format!("Accepted · queued, position {position}")
        }
    }

    pub fn refused_by_owner(self) -> &'static str {
        self.pick("Recusado por você", "Refused by you")
    }

    pub fn closed_in_houston(self) -> &'static str {
        self.pick(
            "Fechado no Houston antes de começar",
            "Closed in Houston before it started",
        )
    }

    /// The refusal modal; Slack caps a modal title at 24 characters.
    pub fn refuse_title(self) -> &'static str {
        self.pick("Recusar pedido", "Refuse request")
    }

    pub fn refuse_label(self) -> &'static str {
        self.pick("Motivo (opcional)", "Reason (optional)")
    }

    pub fn refuse_hint(self) -> &'static str {
        self.pick(
            "Vai para a thread do pedido como você escrever. Quem pediu só fica sabendo do motivo por aqui: sem ele, o pedido recebe só 🚫, que não gera notificação.",
            "Goes to the request's thread as you write it. It is the only way the requester learns why: without it the request only gets 🚫, which sends no notification.",
        )
    }

    /// Under the owner's reason in the thread, so it reads as theirs.
    pub fn reason_by(self, owner: &str) -> String {
        if self.pt() {
            format!("Motivo escrito por <@{owner}>")
        } else {
            format!("Reason written by <@{owner}>")
        }
    }

    pub fn caveats_label(self) -> &'static str {
        self.pick("*Decidido sem perguntar.*", "*Decided without asking.*")
    }

    /// The thread's notification text for a result; the blocks carry the rest.
    pub fn ready_fallback(self, subject: &str) -> String {
        if self.pt() {
            format!("Pronto, aguardando revisão: {subject}. Ainda não está no ar.")
        } else {
            format!("Ready, waiting for review: {subject}. Not live yet.")
        }
    }

    pub fn refused_fallback(self, subject: &str) -> String {
        if self.pt() {
            format!("Não vai seguir: {subject}")
        } else {
            format!("Not going ahead: {subject}")
        }
    }

    pub fn another_change(self, bot: &str) -> String {
        if self.pt() {
            format!("Para outra mudança, mencione {bot} numa mensagem nova no canal.")
        } else {
            format!("For another change, mention {bot} in a new message in the channel.")
        }
    }

    /// What the requester can fix alone, said in the thread.
    pub fn empty_request_reply(self, bot: &str) -> String {
        if self.pt() {
            format!("Faltou o pedido: escreva numa mesma mensagem o que você quer mudar, mencionando {bot}.")
        } else {
            format!("The request is missing: write what you want changed in one message that mentions {bot}.")
        }
    }

    pub fn too_long_reply(self, bot: &str) -> String {
        if self.pt() {
            format!("O pedido ficou longo demais para registrar; resuma e mencione {bot} de novo numa mensagem nova.")
        } else {
            format!("The request is too long to file; shorten it and mention {bot} again in a new message.")
        }
    }

    pub fn attention(self) -> &'static str {
        self.pick("*Atenção*", "*Attention*")
    }

    pub fn not_filed(self, why: &str) -> String {
        if self.pt() {
            format!("não foi registrado: {why}")
        } else {
            format!("was not filed: {why}")
        }
    }

    pub fn too_long(self, len: usize, max: usize) -> String {
        if self.pt() {
            format!("o texto tem {len} bytes, acima do limite de {max}")
        } else {
            format!("its text is {len} bytes, over the {max}-byte limit")
        }
    }

    pub fn empty_request(self) -> &'static str {
        self.pick(
            "a menção não tem texto de pedido",
            "the mention has no request text",
        )
    }

    pub fn could_not_start(self, why: &str) -> String {
        if self.pt() {
            format!("não pôde começar: {why}")
        } else {
            format!("could not start: {why}")
        }
    }

    pub fn waiting_for_confirmation(self) -> &'static str {
        self.pick(
            "aguarda uma confirmação no pane do Houston",
            "is waiting for a confirmation in its Houston pane",
        )
    }

    pub fn stopped(self, reason: &str) -> String {
        if self.pt() {
            format!("parou sem entregar ({reason}). Retome ou tente de novo no Houston.")
        } else {
            format!("stopped without handing back ({reason}). Resume or retry it in Houston.")
        }
    }

    pub fn ended_as(self, state: &str) -> String {
        if self.pt() {
            format!("terminou como {state} no Houston.")
        } else {
            format!("ended as {state} in Houston.")
        }
    }

    pub fn choose(self) -> &'static str {
        self.pick("Escolher", "Choose")
    }

    pub fn recommended(self) -> &'static str {
        self.pick("recomendado", "recommended")
    }

    pub fn other_answer(self) -> &'static str {
        self.pick("Outra resposta…", "Another answer…")
    }

    /// The own-words dialog; Slack caps a modal title at 24 characters.
    pub fn other_title(self) -> &'static str {
        self.pick("Outra resposta", "Another answer")
    }

    pub fn other_label(self) -> &'static str {
        self.pick("Sua resposta", "Your answer")
    }

    pub fn send(self) -> &'static str {
        self.pick("Enviar", "Send")
    }

    pub fn question_hint(self) -> &'static str {
        self.pick(
            "Escolha uma opção acima ou escreva a resposta aqui na thread: sua próxima mensagem aqui vale como resposta.",
            "Pick an option above or write the answer here in the thread: your next message here counts as the answer.",
        )
    }

    pub fn answer_label(self) -> &'static str {
        self.pick("Resposta", "Answer")
    }

    /// `when` is Slack date markup, rendered in each reader's time zone.
    pub fn answered_by(self, user: &str, when: &str) -> String {
        if self.pt() {
            format!("Respondido por <@{user}> {when}")
        } else {
            format!("Answered by <@{user}> {when}")
        }
    }

    pub fn only_requester_answers(self, requester: &str) -> String {
        if self.pt() {
            format!("Esta pergunta é para <@{requester}>, que fez o pedido. Se tiver uma sugestão, fale com essa pessoa.")
        } else {
            format!("This question is for <@{requester}>, who made the request. If you have a suggestion, talk to them.")
        }
    }

    pub fn already_answered(self) -> &'static str {
        self.pick(
            "Esta pergunta já foi respondida.",
            "This question was already answered.",
        )
    }

    pub fn ready_title(self) -> &'static str {
        self.pick(
            "*Pronto, aguardando revisão*",
            "*Ready, waiting for review*",
        )
    }

    pub fn refused_title(self) -> &'static str {
        self.pick("*Não vai seguir*", "*Not going ahead*")
    }

    pub fn what_changes(self) -> &'static str {
        self.pick("*O que muda.*", "*What changes.*")
    }

    pub fn how_to_check(self) -> &'static str {
        self.pick(
            "*Como conferir quando estiver no ar*",
            "*How to check once it is live*",
        )
    }

    pub fn review_note(self) -> &'static str {
        self.pick(
            "Uma pessoa do time de desenvolvimento ainda revisa a mudança e confere a tela antes de ela ir ao ar. Quer mudar algo? Responda aqui descrevendo o ajuste.",
            "A developer still reviews the change and checks the screen before it goes live. Want something different? Reply here describing the adjustment.",
        )
    }

    pub fn dm_ready(self, subject: &str) -> String {
        if self.pt() {
            format!("*Pronto para revisão: {subject}*")
        } else {
            format!("*Ready for review: {subject}*")
        }
    }

    pub fn dm_refused(self, subject: &str) -> String {
        if self.pt() {
            format!("*Recusado na triagem: {subject}*")
        } else {
            format!("*Refused at triage: {subject}*")
        }
    }

    pub fn size_line(self, word: &str, files: usize, added: u64, deleted: u64) -> String {
        if self.pt() {
            let unit = if files == 1 { "arquivo" } else { "arquivos" };
            format!("*Tamanho: {word}* · {files} {unit} · +{added} −{deleted} linhas")
        } else {
            let unit = if files == 1 { "file" } else { "files" };
            format!("*Size: {word}* · {files} {unit} · +{added} −{deleted} lines")
        }
    }

    pub fn size_word(self, size: crate::slack::form::Size) -> &'static str {
        use crate::slack::form::Size;
        match size {
            Size::Small => self.pick("pequeno", "small"),
            Size::Medium => self.pick("médio", "medium"),
            Size::Large => self.pick("grande", "large"),
        }
    }

    pub fn branch_pushed(self, branch: &str) -> String {
        if self.pt() {
            format!("Branch `{branch}`, enviada")
        } else {
            format!("Branch `{branch}`, pushed")
        }
    }

    pub fn branch_local(self, branch: &str) -> String {
        if self.pt() {
            format!("Branch `{branch}`, não enviada")
        } else {
            format!("Branch `{branch}`, not pushed")
        }
    }

    pub fn open_pr(self) -> &'static str {
        self.pick("Abrir pull request", "Open pull request")
    }

    pub fn view_thread(self) -> &'static str {
        self.pick("Ver thread", "View thread")
    }

    pub fn work_time(self, minutes: i64) -> String {
        if self.pt() {
            format!("{minutes} min de trabalho")
        } else {
            format!("{minutes} min of work")
        }
    }

    pub fn adjustment_title(self, subject: &str) -> String {
        if self.pt() {
            format!("*Pedido de ajuste:* {subject}")
        } else {
            format!("*Adjustment requested:* {subject}")
        }
    }

    pub fn adjustment_started(self) -> &'static str {
        self.pick(
            "Aceito · nova tentativa começou",
            "Accepted · a new attempt started",
        )
    }

    pub fn adjustment_outdated(self) -> &'static str {
        self.pick(
            "Desatualizado: houve outra entrega depois deste pedido de ajuste",
            "Outdated: another result was handed back after this adjustment",
        )
    }

    pub fn adjustment_busy(self, working: usize, cap: usize) -> String {
        if self.pt() {
            format!("tem {working} em andamento (limite {cap}); aceite o ajuste de novo quando um terminar")
        } else {
            format!("has {working} working (limit {cap}); accept the adjustment again when one finishes")
        }
    }

    pub fn images_over_count(self, max: usize, attached: usize) -> String {
        if self.pt() {
            format!("Só as {max} primeiras imagens entraram ({attached} anexadas).")
        } else {
            format!("Only the first {max} files were kept ({attached} attached).")
        }
    }

    pub fn image_too_big(self, name: &str, size: u64, max: u64) -> String {
        if self.pt() {
            format!("{name} tem {size} bytes, acima do limite de {max}; ficou de fora.")
        } else {
            format!("{name} is {size} bytes, over the {max}-byte limit; left out.")
        }
    }

    pub fn image_failed(self, name: &str, why: &str) -> String {
        if self.pt() {
            format!("{name} ficou de fora ({why}).")
        } else {
            format!("{name} was left out ({why}).")
        }
    }

    pub fn not_an_image(self, name: &str) -> String {
        if self.pt() {
            format!("{name} não é uma imagem PNG, JPEG, GIF ou WebP; ficou de fora.")
        } else {
            format!("{name} is not a PNG, JPEG, GIF or WebP image; left out.")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_phrase_follows_the_language() {
        let pt = Text(SlackLanguage::PtBr);
        let en = Text(SlackLanguage::En);
        assert_eq!(pt.accept(), "Aceitar");
        assert_eq!(en.accept(), "Accept");
        assert_eq!(
            pt.start_outlook(2, 2),
            "2 em andamento (limite 2); entra na fila"
        );
        assert_eq!(en.start_outlook(1, 2), "1 working; it starts right away");
        assert!(pt.refuse_title().chars().count() <= 24);
        assert!(pt.other_title().chars().count() <= 24);
        assert_eq!(
            pt.size_line("médio", 11, 482, 0),
            "*Tamanho: médio* · 11 arquivos · +482 −0 linhas"
        );
        assert!(en.refuse_title().chars().count() <= 24);
    }
}
