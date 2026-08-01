import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { acquireIdentityLock, identityLockPath, IdentityLockBusyError } from "./lock";

const IDENTITIES_DIR = "/home/testuser/.claude-use/identities";

function fakeSleep(): { sleep: (ms: number) => void; calls: number[] } {
  const calls: number[] = [];
  return { sleep: (ms: number) => calls.push(ms), calls };
}

describe("acquireIdentityLock", () => {
  it("takes a free lock, records the holder, and removes the file on release", () => {
    const fs = createFakeFarmFs();
    const sleeper = fakeSleep();

    const lock = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_000,
      pid: 42,
      isProcessAlive: () => true,
      sleep: sleeper.sleep,
    });

    expect(lock.path).toBe(identityLockPath(IDENTITIES_DIR, "work"));
    const record: unknown = JSON.parse(fs.readFileUtf8(lock.path) ?? "null");
    expect(record).toMatchObject({ identity: "work", pid: 42, acquiredAtMs: 1_000 });
    expect(sleeper.calls).toHaveLength(0);

    lock.release();
    expect(fs.readFileUtf8(lock.path)).toBeUndefined();
  });

  it("waits and then refuses when another live process holds the lock", () => {
    const fs = createFakeFarmFs();
    const sleeper = fakeSleep();
    const held = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_000,
      pid: 42,
      isProcessAlive: () => true,
      sleep: sleeper.sleep,
    });

    expect(() =>
      acquireIdentityLock({
        identity: "work",
        dir: IDENTITIES_DIR,
        fs,
        nowMs: () => 1_100,
        pid: 43,
        isProcessAlive: () => true,
        sleep: sleeper.sleep,
        maxAttempts: 3,
        retryDelayMs: 5,
      }),
    ).toThrow(IdentityLockBusyError);
    expect(sleeper.calls).toEqual([5, 5, 5]);

    // Serialisation, not exclusion: once the holder is done, the same waiter succeeds.
    held.release();
    const second = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_200,
      pid: 43,
      isProcessAlive: () => true,
      sleep: sleeper.sleep,
      maxAttempts: 3,
    });
    expect(JSON.parse(fs.readFileUtf8(second.path) ?? "null")).toMatchObject({ pid: 43 });
  });

  it("names the blocking process in the error so a wedged lock is diagnosable", () => {
    const fs = createFakeFarmFs();
    acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_000,
      pid: 4242,
      isProcessAlive: () => true,
      sleep: fakeSleep().sleep,
    });

    expect(() =>
      acquireIdentityLock({
        identity: "work",
        dir: IDENTITIES_DIR,
        fs,
        nowMs: () => 1_000,
        pid: 43,
        isProcessAlive: () => true,
        sleep: fakeSleep().sleep,
        maxAttempts: 1,
      }),
    ).toThrow(/pid 4242/);
  });

  it("steals a lock whose holder is no longer running", () => {
    const fs = createFakeFarmFs();
    acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_000,
      pid: 42,
      isProcessAlive: () => true,
      sleep: fakeSleep().sleep,
    });

    const sleeper = fakeSleep();
    const stolen = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_001,
      pid: 43,
      isProcessAlive: (pid) => pid === 43,
      sleep: sleeper.sleep,
      maxAttempts: 3,
    });

    expect(JSON.parse(fs.readFileUtf8(stolen.path) ?? "null")).toMatchObject({ pid: 43 });
    expect(sleeper.calls).toHaveLength(0);
  });

  it("steals a lock older than the staleness window even when its holder is still alive", () => {
    const fs = createFakeFarmFs();
    acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_000,
      pid: 42,
      isProcessAlive: () => true,
      sleep: fakeSleep().sleep,
    });

    const stolen = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_000 + 200_000,
      pid: 43,
      isProcessAlive: () => true,
      sleep: fakeSleep().sleep,
      maxAttempts: 3,
    });

    expect(JSON.parse(fs.readFileUtf8(stolen.path) ?? "null")).toMatchObject({ pid: 43 });
  });

  it("steals a lock whose contents are unparseable, rather than waiting out a truncated write", () => {
    const fs = createFakeFarmFs();
    fs.mkdirp(IDENTITIES_DIR);
    fs.writeFileUtf8(identityLockPath(IDENTITIES_DIR, "work"), '{"identity":"wo');

    const lock = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_000,
      pid: 43,
      isProcessAlive: () => true,
      sleep: fakeSleep().sleep,
      maxAttempts: 3,
    });

    expect(JSON.parse(fs.readFileUtf8(lock.path) ?? "null")).toMatchObject({ pid: 43 });
  });

  it("does not release a lock another process has since taken", () => {
    const fs = createFakeFarmFs();
    const first = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_000,
      pid: 42,
      isProcessAlive: () => true,
      sleep: fakeSleep().sleep,
    });

    // The holder is presumed dead and its lock is taken by someone else; the original's own release must then be a no-op rather than unlocking the new holder.
    const second = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => 1_001,
      pid: 43,
      isProcessAlive: (pid) => pid === 43,
      sleep: fakeSleep().sleep,
    });
    first.release();

    expect(JSON.parse(fs.readFileUtf8(second.path) ?? "null")).toMatchObject({ pid: 43, token: second.token });
  });
});
