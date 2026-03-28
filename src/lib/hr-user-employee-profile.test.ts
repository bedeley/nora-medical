import test from "node:test";
import assert from "node:assert/strict";
import {
  detectEmployeeProfileMatchSource,
  splitEmployeeName,
} from "@/lib/hr-user-employee-profile";

test("splitEmployeeName returns sensible defaults", () => {
  assert.deepEqual(splitEmployeeName(""), { firstName: "Employee", lastName: "User" });
  assert.deepEqual(splitEmployeeName("Nora"), { firstName: "Nora", lastName: "Employee" });
  assert.deepEqual(splitEmployeeName("Kwesi Yeboah"), { firstName: "Kwesi", lastName: "Yeboah" });
});

test("detectEmployeeProfileMatchSource identifies email and phone matches", () => {
  assert.equal(
    detectEmployeeProfileMatchSource({
      matchedEmail: "admin@example.com",
      email: "admin@example.com",
    }),
    "email",
  );
  assert.equal(
    detectEmployeeProfileMatchSource({
      matchedPhone: "0241000000",
      phone: "0241000000",
    }),
    "phone",
  );
  assert.equal(
    detectEmployeeProfileMatchSource({
      matchedEmail: "admin@example.com",
      email: "admin@example.com",
      matchedPhone: "0241000000",
      phone: "0241000000",
    }),
    "email_and_phone",
  );
  assert.equal(
    detectEmployeeProfileMatchSource({
      matchedEmail: "admin@example.com",
      email: "other@example.com",
    }),
    "none",
  );
});
