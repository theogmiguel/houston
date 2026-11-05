// One fixture pins the Windows PATH both the host's prepared spawn and the
// server's own PowerShell merge must produce.
export const HOST_PREPARED_FIXTURE = {
  inherited: String.raw`C:\Windows;"C:\Program Files\nodejs";c:\windows;;C:\Users\u\.bun\bin;C:\Users\José\bin`,
  prepared: [
    String.raw`C:\Windows`,
    String.raw`C:\Program Files\nodejs`,
    String.raw`C:\Users\u\.bun\bin`,
    String.raw`C:\Users\José\bin`,
    String.raw`C:\Users\u\AppData\Roaming\npm`,
    String.raw`C:\Users\u\AppData\Local\Programs\nodejs`,
    String.raw`C:\Users\u\AppData\Local\Volta\bin`,
    String.raw`C:\Users\u\AppData\Local\pnpm`,
    String.raw`C:\Users\u\.local\bin`,
    String.raw`C:\Users\u\scoop\shims`,
  ].join(";"),
} as const;

export function hostFixtureEnv(): NodeJS.ProcessEnv {
  return {
    Path: HOST_PREPARED_FIXTURE.inherited,
    APPDATA: String.raw`C:\Users\u\AppData\Roaming`,
    LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local`,
    USERPROFILE: String.raw`C:\Users\u`,
  };
}
