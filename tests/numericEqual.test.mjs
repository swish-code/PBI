// Unit tests for the golden comparator. Run: node tests/numericEqual.test.mjs
import assert from "node:assert";
import { deepNumericEqual, numbersClose } from "./lib/numericEqual.mjs";

let n = 0; const ok = (c, m) => { n++; assert.ok(c, m); };

// ULP noise passes (relative 1e-9)
ok(numbersClose(27479.75000000001, 27479.750000000007), "ULP noise within rel tol");
ok(deepNumericEqual({ a: 27479.75000000001 }, { a: 27479.750000000007 }).equal, "obj ULP passes");
// near-zero absolute tolerance
ok(numbersClose(0, 5e-7), "near-zero within abs tol");
ok(!numbersClose(0, 1e-3), "0 vs 1e-3 fails");
// real numeric diff fails
ok(!deepNumericEqual({ a: 100 }, { a: 101 }).equal, "real numeric diff fails");
// strings are exact â€” case change fails
ok(!deepNumericEqual({ x: "Pepsi Zero" }, { x: "PEPSI ZERO" }).equal, "string case fails");
ok(deepNumericEqual({ x: "Pepsi" }, { x: "Pepsi" }).equal, "same string passes");
// row arrays are order-insensitive (tied sort)
const A = { rows: [{ item: "A", v: 10 }, { item: "B", v: 10 }] };
const B = { rows: [{ item: "B", v: 10 }, { item: "A", v: 10 }] };
ok(deepNumericEqual(A, B).equal, "reordered rows pass");
// but a value diff inside a reordered row still fails
const C = { rows: [{ item: "B", v: 10 }, { item: "A", v: 999 }] };
ok(!deepNumericEqual(A, C).equal, "reordered rows with value diff fail");
// array length mismatch fails
ok(!deepNumericEqual({ rows: [1, 2] }, { rows: [1] }).equal, "length mismatch fails");

console.log(`\nall ${n} comparator assertions passed`);

