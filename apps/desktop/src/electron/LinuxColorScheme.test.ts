import * as NodeEvents from "node:events";

import { Message, MessageType, Variant, type MessageBus } from "dbus-next";
import { expect, it } from "vite-plus/test";

import { watchLinuxColorScheme, type LinuxColorScheme } from "./LinuxColorScheme.ts";

class FakeBus extends NodeEvents.EventEmitter {
  readonly calls: string[] = [];
  disconnected = false;
  readonly readReply: unknown;
  constructor(readReply: unknown) {
    super();
    this.readReply = readReply;
  }
  call(message: Message) {
    this.calls.push(message.member ?? "");
    if (message.member === "ReadOne") return Promise.resolve({ body: [this.readReply] });
    return Promise.resolve(null);
  }
  disconnect() {
    this.disconnected = true;
  }
}

const settingChanged = (value: number) =>
  new Message({
    type: MessageType.SIGNAL,
    path: "/org/freedesktop/portal/desktop",
    interface: "org.freedesktop.portal.Settings",
    member: "SettingChanged",
    signature: "ssv",
    body: ["org.freedesktop.appearance", "color-scheme", new Variant("u", value)],
  });

it("reports the portal's scheme and its later changes, then stops listening", async () => {
  const bus = new FakeBus(new Variant("u", 1));
  const seen: LinuxColorScheme[] = [];
  const watcher = watchLinuxColorScheme(
    (scheme) => seen.push(scheme),
    () => bus as unknown as MessageBus,
  );
  await watcher.ready;
  expect(bus.calls).toEqual(["AddMatch", "ReadOne"]);
  expect(seen).toEqual(["dark"]);

  bus.emit("message", settingChanged(2));
  expect(seen).toEqual(["dark", "light"]);

  watcher.stop();
  expect(bus.disconnected).toBe(true);
  expect(bus.listenerCount("message")).toBe(0);
  bus.emit("message", settingChanged(1));
  expect(seen).toEqual(["dark", "light"]);
});

it("never opens the session bus when stopped before the D-Bus client loads", async () => {
  let connected = false;
  const watcher = watchLinuxColorScheme(
    () => {
      throw new Error("a stopped watcher reported a scheme");
    },
    () => {
      connected = true;
      return new FakeBus(new Variant("u", 1)) as unknown as MessageBus;
    },
  );
  watcher.stop();
  await watcher.ready;
  expect(connected).toBe(false);
});
