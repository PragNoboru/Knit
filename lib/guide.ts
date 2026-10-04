import "server-only";

import { z } from "zod";

import {
  parseTemplateLink,
  TEMPLATE_LINK_KEY,
  type TemplateLink,
} from "@/lib/domain/guide";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * PRD 12.9, N80, 9.3: the tracker template link for the Guide, for every signed-in user.
 * `settings` is the admin's to read (9.2), so this one key is read on the server with the
 * service role; nothing else of `settings` is read, and the link is never logged. A saved value
 * that is no longer a valid link shows as no link.
 */
export async function loadTemplateLink(): Promise<TemplateLink | null> {
  const { data, error } = await createServiceClient()
    .from("settings")
    .select("value")
    .eq("key", TEMPLATE_LINK_KEY)
    .maybeSingle();
  if (error) throw new Error(`settings read failed: ${error.code}`);
  const value = z.object({ value: z.string() }).safeParse(data);
  return value.success ? parseTemplateLink(value.data.value) : null;
}
