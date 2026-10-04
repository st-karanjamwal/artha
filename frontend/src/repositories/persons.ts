import { all, one, run } from '@/db/sql';
import { encryptSecret } from '@/crypto/secrets';
import { nowUtc } from '@/lib/dates';
import { blankToNull } from '@/lib/validators';

export interface Person {
  PersonId: number;
  FirstName: string;
  LastName: string | null;
  Relationship: string;
  DateOfBirth: string | null;
  Gender: string | null;
  Email: string | null;
  Phone: string | null;
  Address: string | null;
  PAN_Enc: string | null;
  Aadhaar_Enc: string | null;
  Notes: string | null;
  CreatedOn: string;
  UpdatedOn: string;
  IsActive: number;
}

export interface PersonInput {
  FirstName: string;
  LastName?: string;
  Relationship: string;
  DateOfBirth?: string;
  Gender?: string;
  Email?: string;
  Phone?: string;
  Address?: string;
  Notes?: string;
  /** Plaintext; empty string = keep existing value. */
  PAN?: string;
  Aadhaar?: string;
  clearPAN?: boolean;
  clearAadhaar?: boolean;
}

export const personName = (p: Pick<Person, 'FirstName' | 'LastName'>) =>
  [p.FirstName, p.LastName].filter(Boolean).join(' ');

export function listPersons(includeInactive = false): Person[] {
  return all<Person>(
    `SELECT p.* FROM Persons p
     LEFT JOIN LookupValues l ON l.Category = 'Relationship' AND l.Code = p.Relationship
     ${includeInactive ? '' : 'WHERE p.IsActive = 1'}
     ORDER BY p.IsActive DESC, COALESCE(l.SortOrder, 99), p.DateOfBirth, p.FirstName`,
  );
}

export function getPerson(id: number): Person | undefined {
  return one<Person>('SELECT * FROM Persons WHERE PersonId = ?', [id]);
}

async function secretCol(
  value: string | undefined,
  clear: boolean | undefined,
  existing: string | null,
): Promise<string | null> {
  if (clear) return null;
  const v = value?.trim().toUpperCase().replace(/\s/g, '');
  return v ? encryptSecret(v) : existing;
}

export async function createPerson(input: PersonInput): Promise<number> {
  const pan = await secretCol(input.PAN, false, null);
  const aadhaar = await secretCol(input.Aadhaar, false, null);
  const now = nowUtc();
  return run(
    `INSERT INTO Persons (FirstName, LastName, Relationship, DateOfBirth, Gender, Email, Phone,
       Address, PAN_Enc, Aadhaar_Enc, Notes, CreatedOn, UpdatedOn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.FirstName.trim(),
      blankToNull(input.LastName),
      input.Relationship,
      blankToNull(input.DateOfBirth),
      blankToNull(input.Gender),
      blankToNull(input.Email),
      blankToNull(input.Phone),
      blankToNull(input.Address),
      pan,
      aadhaar,
      blankToNull(input.Notes),
      now,
      now,
    ],
  ).lastId;
}

export async function updatePerson(id: number, input: PersonInput): Promise<void> {
  const existing = getPerson(id);
  if (!existing) throw new Error('Person not found');
  const pan = await secretCol(input.PAN, input.clearPAN, existing.PAN_Enc);
  const aadhaar = await secretCol(input.Aadhaar, input.clearAadhaar, existing.Aadhaar_Enc);
  run(
    `UPDATE Persons SET FirstName = ?, LastName = ?, Relationship = ?, DateOfBirth = ?, Gender = ?,
       Email = ?, Phone = ?, Address = ?, PAN_Enc = ?, Aadhaar_Enc = ?, Notes = ?, UpdatedOn = ?
     WHERE PersonId = ?`,
    [
      input.FirstName.trim(),
      blankToNull(input.LastName),
      input.Relationship,
      blankToNull(input.DateOfBirth),
      blankToNull(input.Gender),
      blankToNull(input.Email),
      blankToNull(input.Phone),
      blankToNull(input.Address),
      pan,
      aadhaar,
      blankToNull(input.Notes),
      nowUtc(),
      id,
    ],
  );
}

export function setPersonActive(id: number, active: boolean) {
  run('UPDATE Persons SET IsActive = ?, UpdatedOn = ? WHERE PersonId = ?', [active, nowUtc(), id]);
}
