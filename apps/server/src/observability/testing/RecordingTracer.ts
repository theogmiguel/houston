import * as Tracer from "effect/Tracer";

/** A tracer that keeps every span it creates; `ended` lists them in the order they ended. */
export const make = () => {
  const started: Array<Tracer.NativeSpan> = [];
  const ended: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      started.push(span);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        ended.push(span);
      };
      return span;
    },
  });
  const named = (name: string) => ended.filter((span) => span.name === name);
  return { tracer, started, ended, named };
};
