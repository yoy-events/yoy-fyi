// CSV parsing and writing for link import and export.
import { describe, expect, test } from "bun:test";
import { parseCsv, toCsv } from "../src/csv";

describe("parseCsv", () => {
  test.each([
    ["plain rows", "a,b\n1,2", [["a", "b"], ["1", "2"]]],
    ["CRLF and a trailing newline", "a,b\r\n1,2\r\n", [["a", "b"], ["1", "2"]]],
    ["quoted commas, quotes and newlines", 'a,b\n"x, y","say ""hi""\nthere"', [["a", "b"], ["x, y", 'say "hi"\nthere']]],
    ["empty cells", "a,b,c\n,,", [["a", "b", "c"], ["", "", ""]]],
    ["blank lines skipped", "a\n\n1\n\n", [["a"], ["1"]]],
    ["a UTF-8 BOM", "﻿a\n1", [["a"], ["1"]]],
    ["nothing", "", []],
  ])("%s", (_, text, rows) => {
    expect(parseCsv(text)).toEqual(rows);
  });

  test("an unclosed quote is an error", () => {
    expect(parseCsv('a\n"open')).toEqual({ error: "У CSV не закрита лапка." });
  });
});

describe("toCsv", () => {
  test("quotes what needs quoting and ends lines with CRLF", () => {
    expect(toCsv([["a", "b, c"], ['say "hi"', "x\ny"]])).toBe('a,"b, c"\r\n"say ""hi""","x\ny"\r\n');
  });

  test("neutralises cells a spreadsheet would run as a formula", () => {
    expect(toCsv([["=1+1", "+x", "-y", "@z", "ok"]])).toBe("'=1+1,'+x,'-y,'@z,ok\r\n");
    expect(toCsv([[" =1", "\tx", "|cmd"]])).toBe("' =1,'\tx,'|cmd\r\n");
  });

  test("null and numbers", () => {
    expect(toCsv([[null, 3, true]])).toBe(",3,true\r\n");
  });
});
