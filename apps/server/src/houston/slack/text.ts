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
  };
};

export type SlackText = ReturnType<typeof slackText>;
