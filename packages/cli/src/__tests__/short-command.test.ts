import { describe, expect, it } from "vitest";
import { createProgram } from "../program.js";

describe("short command", () => {
  it("registers public short run command", () => {
    const program = createProgram();
    const short = program.commands.find((command) => command.name() === "short");
    expect(short).toBeDefined();
    expect(short?.commands.some((command) => command.name() === "run")).toBe(true);
  });
});
