import type { Metadata } from "next";

import { ActionButton } from "@/components/admin/action-button";
import { ActionForm } from "@/components/admin/action-form";
import {
  Field,
  NativeSelect,
  Section,
  Table,
  TextInput,
} from "@/components/admin/fields";
import {
  createUser,
  resetPassword,
  saveAlias,
  setUserActive,
} from "@/lib/actions/admin";
import { loadPeople } from "@/lib/admin/data";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "People · Knit" };

// PRD 12.8 People: users (create, deactivate, reset password) and aliases (add, link to a
// user, mark as non-user). D6: only the admin creates logins.
export default async function PeoplePage() {
  const [{ users, aliases }, me] = await Promise.all([
    loadPeople(),
    getCurrentUser(),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">People</h1>

      <Section title="Users">
        <Table head={["Name", "Email", "Role", "State", "Password", ""]}>
          {users.map((user) => (
            <tr key={user.id}>
              <td className="font-medium">{user.name}</td>
              <td>{user.email}</td>
              <td>{user.role === "admin" ? "Admin" : "Member"}</td>
              <td>{user.is_active ? "Active" : "Deactivated"}</td>
              <td>
                <details>
                  <summary className="cursor-pointer text-sm underline">
                    Reset
                  </summary>
                  <ActionForm
                    action={resetPassword.bind(null, user.id)}
                    submitLabel="Set password"
                    submitVariant="outline"
                    className="mt-2 w-56"
                  >
                    <TextInput
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      aria-label={`New password for ${user.name}`}
                      minLength={8}
                      required
                    />
                  </ActionForm>
                </details>
              </td>
              <td>
                {user.id === me?.id ? null : user.is_active ? (
                  <ActionButton
                    action={setUserActive.bind(null, user.id, false)}
                    confirm={`Deactivate ${user.name}? They can no longer sign in.`}
                  >
                    Deactivate
                  </ActionButton>
                ) : (
                  <ActionButton
                    action={setUserActive.bind(null, user.id, true)}
                  >
                    Activate
                  </ActionButton>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Add a user"
        description="They sign in with this email and password; tell them the password yourself."
      >
        <ActionForm action={createUser} submitLabel="Create user">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Name" htmlFor="name">
              <TextInput id="name" name="name" required maxLength={80} />
            </Field>
            <Field label="Email" htmlFor="email">
              <TextInput id="email" name="email" type="email" required />
            </Field>
            <Field label="Role" htmlFor="role">
              <NativeSelect id="role" name="role" defaultValue="member">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </NativeSelect>
            </Field>
            <Field
              label="Password"
              htmlFor="password"
              hint="At least 8 characters."
            >
              <TextInput
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Field>
            <Field
              label="Name in trackers"
              htmlFor="alias"
              hint="Optional, for example Shlok."
            >
              <TextInput id="alias" name="alias" maxLength={80} />
            </Field>
          </div>
        </ActionForm>
      </Section>

      <Section
        title="Names in trackers"
        description="How owner names in the sheets map to people. Changes apply at the next pull."
      >
        <Table head={["Name", "Shown as", "Person"]}>
          {aliases.map((alias) => (
            <tr key={alias.alias_norm}>
              <td>{alias.alias_norm}</td>
              <td>{alias.display}</td>
              <td>
                {alias.user_id
                  ? (names.get(alias.user_id) ?? "Unknown user")
                  : "Not a Knit user"}
              </td>
            </tr>
          ))}
        </Table>
        <div className="mt-4">
          <ActionForm action={saveAlias} submitLabel="Save name">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name as the trackers write it" htmlFor="alias-name">
                <TextInput
                  id="alias-name"
                  name="alias"
                  required
                  maxLength={80}
                />
              </Field>
              <Field label="Person" htmlFor="alias-user">
                <NativeSelect id="alias-user" name="user" defaultValue="">
                  <option value="">Choose</option>
                  {users
                    .filter((u) => u.is_active)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  <option value="non_user">Not a Knit user</option>
                </NativeSelect>
              </Field>
            </div>
          </ActionForm>
        </div>
      </Section>
    </div>
  );
}
