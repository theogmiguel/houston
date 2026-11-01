// Houston's own words in Slack, in the intake's language, as Houston 1 phrased them. Slack text
// quoted here is escaped by the caller.
import { HOUSTON_SLACK_LIMITS, type HoustonSlackLanguage } from "@t3tools/contracts/houston/slack";

export type LeftOutReason = "host" | "type" | "size" | "count" | "failed";

export const slackText = (language: HoustonSlackLanguage) => {
  const pt = language === "pt-BR";
  const pick = (ptBr: string, en: string) => (pt ? ptBr : en);
  return {
    accept: pick("Aceitar", "Accept"),
    refuse: pick("Recusar", "Refuse"),
    cancel: pick("Cancelar", "Cancel"),
    viewMessage: pick("Ver mensagem", "View message"),
    newRequest: (channel: string, author: string) =>
      pt
        ? `*Novo pedido* em <#${channel}>, de <@${author}>`
        : `*New request* in <#${channel}>, from <@${author}>`,
    startOutlook: (working: number) => {
      const cap = HOUSTON_SLACK_LIMITS.workingRuns;
      if (working === 0) {
        return pick(
          "nenhum trabalho em andamento, começa na hora",
          "nothing else is working; it starts right away",
        );
      }
      if (working < cap) {
        return pick(
          `${working} em andamento, começa na hora`,
          `${working} working; it starts right away`,
        );
      }
      return pick(
        `${working} em andamento (limite ${cap}); entra na fila`,
        `${working} working (limit ${cap}); it joins the queue`,
      );
    },
    acceptedStarted: pick("Aceito · começou", "Accepted · started"),
    acceptedQueued: (position: number) =>
      pick(`Aceito · na fila, posição ${position}`, `Accepted · queued, position ${position}`),
    closedInHouston: pick(
      "Fechado no Houston antes de começar",
      "Closed in Houston before it started",
    ),
    refusedByOwner: pick("Recusado", "Refused"),
    refuseTitle: pick("Recusar pedido", "Refuse request"),
    refuseLabel: pick("Motivo (opcional)", "Reason (optional)"),
    refuseHint: pick(
      "Vai para a thread do pedido como você escrever. Sem ele, o pedido recebe só 🚫, que não gera notificação.",
      "Goes to the request's thread as you write it. Without it the request only gets 🚫, which sends no notification.",
    ),
    notGoingAhead: pick("*Não vai seguir*", "*Not going ahead*"),
    reasonBy: (owner: string) =>
      pick(`Motivo escrito por <@${owner}>`, `Reason written by <@${owner}>`),
    emptyRequestReply: (bot: string) =>
      pick(
        `Faltou o pedido. Responda aqui mesmo dizendo o que você quer mudar; um print ajuda. (Mencione <@${bot}> quando fizer um pedido novo no canal.)`,
        `The request is missing. Reply right here with what you want changed; a screenshot helps. (Mention <@${bot}> when you make a new request in the channel.)`,
      ),
    tooLongReply: (bot: string) =>
      pick(
        `O pedido passou do tamanho que dá para registrar. Responda aqui mesmo com um resumo. (Mencione <@${bot}> quando fizer um pedido novo no canal.)`,
        `The request is too long to file. Reply right here with a summary. (Mention <@${bot}> when you make a new request in the channel.)`,
      ),
    attention: pick("*Atenção*", "*Attention*"),
    notFiled: (why: string) => pick(`não foi registrado: ${why}`, `was not filed: ${why}`),
    tooLong: (size: number) =>
      pick(
        `o texto tem ${size} bytes, acima do limite de ${HOUSTON_SLACK_LIMITS.requestBytes}`,
        `its text is ${size} bytes, over the ${HOUSTON_SLACK_LIMITS.requestBytes}-byte limit`,
      ),
    emptyRequest: pick("a menção não tem texto de pedido", "the mention has no request text"),
    notReady: (reasons: ReadonlyArray<string>) =>
      pick(
        `ainda não está pronto para começar: ${reasons.join("; ")}`,
        `is not ready to start yet: ${reasons.join("; ")}`,
      ),
    couldNotStart: (why: string) => pick(`não pôde começar: ${why}`, `could not start: ${why}`),
    onlyOwner: pick(
      "Só o responsável por estes pedidos pode aceitar ou recusar.",
      "Sorry, only the owner can accept or refuse this request.",
    ),
    leftOutHeading: pick("Arquivos deixados de fora:", "Files left out:"),
    leftOut: (reason: LeftOutReason) => {
      switch (reason) {
        case "host":
          return pick("não está num host de arquivos do Slack", "not on a Slack file host");
        case "type":
          return pick(
            "não é uma imagem PNG, JPEG, GIF ou WebP",
            "not a PNG, JPEG, GIF or WebP image",
          );
        case "size":
          return pick("maior que 10 MiB", "larger than 10 MiB");
        case "count":
          return pick(
            `além do limite de ${HOUSTON_SLACK_LIMITS.images} imagens`,
            `over the limit of ${HOUSTON_SLACK_LIMITS.images} images`,
          );
        case "failed":
          return pick("o download falhou", "the download failed");
      }
    },
    start: pick("Início", "Start"),
    // Questions.
    recommended: pick("recomendada", "recommended"),
    otherAnswer: pick("Outra resposta…", "Another answer…"),
    otherTitle: pick("Outra resposta", "Another answer"),
    otherLabel: pick("Sua resposta", "Your answer"),
    send: pick("Enviar", "Send"),
    questionHint: pick(
      "Escolha uma opção acima ou responda aqui na thread: sua próxima mensagem vale como resposta.",
      "Pick an option above or reply here in the thread: your next message counts as the answer.",
    ),
    answerLabel: pick("*Resposta*", "*Answer*"),
    answeredBy: (user: string) => pick(`Respondido por <@${user}>`, `Answered by <@${user}>`),
    questionClosed: pick(
      "_Pergunta encerrada: a execução terminou antes de uma resposta._",
      "_Question closed: the run ended before it was answered._",
    ),
    questionClosedNotice: pick(
      "Esta pergunta foi encerrada quando a execução terminou, então a resposta não foi enviada.",
      "This question closed when its run ended, so the answer was not sent.",
    ),
    onlyRequesterAnswers: (requester: string) =>
      pick(
        `Esta pergunta é para <@${requester}>, que fez o pedido. Se tiver uma sugestão, fale com <@${requester}>.`,
        `This question is for <@${requester}>, who made the request. If you have a suggestion, talk to <@${requester}>.`,
      ),
    // Hand-back and closing.
    readyTitle: pick("*Pronto, aguardando revisão*", "*Ready, waiting for review*"),
    whatChanges: pick("*O que muda.*", "*What changes.*"),
    howToCheck: pick("*Como conferir quando estiver no ar*", "*How to check once it is live*"),
    caveatsLabel: pick("*Observações.*", "*Caveats.*"),
    reviewNote: pick(
      "Uma pessoa do time de desenvolvimento ainda revisa a mudança e confere a tela antes de ela ir ao ar. Quer mudar algo? Responda aqui descrevendo o ajuste.",
      "A developer still reviews the change and checks the screen before it goes live. Want something different? Reply here describing the adjustment.",
    ),
    dmReady: (subject: string) =>
      pick(`*Pronto para revisão: ${subject}*`, `*Ready for review: ${subject}*`),
    dmRefused: (subject: string) =>
      pick(`*Recusado na triagem: ${subject}*`, `*Refused at triage: ${subject}*`),
    size: (size: "small" | "medium" | "large") =>
      pt
        ? `Tamanho: ${{ small: "pequeno", medium: "médio", large: "grande" }[size]}`
        : `Size: ${size}`,
    branch: (branch: string) => pick(`Branch \`${branch}\``, `Branch \`${branch}\``),
    pullRequest: (url: string) => pick(`Pull request: ${url}`, `Pull request: ${url}`),
    blockersLabel: pick("*Bloqueios*", "*Blockers*"),
    warningsLabel: pick("*Avisos*", "*Warnings*"),
    factsLabel: pick("*Fatos*", "*Facts*"),
    workTime: (minutes: number) =>
      pick(`Tempo de trabalho: ${minutes} min`, `Time worked: ${minutes} min`),
    liveDefault: pick("Está no ar.", "It is live."),
    droppedDefault: pick("Este pedido não vai seguir.", "This request will not go ahead."),
    anotherChange: (bot: string) =>
      pick(
        `Para outra mudança, mencione <@${bot}> numa mensagem nova no canal.`,
        `For another change, mention <@${bot}> in a new message in the channel.`,
      ),
    // Attention.
    runStopped: pick("a execução parou", "the run stopped"),
    runFailed: (reason: string) =>
      pick(`a execução falhou: ${reason}`, `the run failed: ${reason}`),
    runWaiting: pick(
      "a execução está esperando uma confirmação na thread dela",
      "the run is waiting for a confirmation in its thread",
    ),
    // Replies and adjustments.
    addedInSlack: (date: string) => pick(`Adicionado no Slack em ${date}:`, `Added in Slack on ${date}:`),
    replyTooLong: (chars: number) =>
      pick(
        `Sua resposta tem ${chars} caracteres, acima do limite de ${HOUSTON_SLACK_LIMITS.dialogChars}; nada foi feito com ela. Responda de novo de forma mais curta.`,
        `Your reply is ${chars} characters, over the ${HOUSTON_SLACK_LIMITS.dialogChars}-character limit; nothing was done with it. Reply again more briefly.`,
      ),
    replyNotJoined: (why: string) =>
      pick(
        `uma resposta na thread não pôde ser adicionada à tarefa: ${why}`,
        `a thread reply could not be added to the task: ${why}`,
      ),
    midWork: pick("*Resposta durante o trabalho*", "*Reply during the work*"),
    midWorkHint: pick(
      "O agente não recebe esta mensagem: se ela muda o pedido, passe adiante no Houston ou peça um ajuste depois da entrega.",
      "The agent does not get this message: if it changes the request, pass it on in Houston, or ask for an adjustment after the hand-back.",
    ),
    adjustmentTitle: pick("*Pedido de ajuste*", "*Adjustment requested*"),
    ignore: pick("Ignorar", "Ignore"),
    ignored: pick("Ignorado · a resposta só perdeu o 👀", "Ignored · the reply only lost its 👀"),
    adjustmentStarted: pick("Aceito · nova tentativa começou", "Accepted · a new attempt started"),
    adjustmentClosed: pick(
      "A tarefa foi fechada sem este ajuste",
      "The task was closed without this adjustment",
    ),
  };
};

export type SlackText = ReturnType<typeof slackText>;
