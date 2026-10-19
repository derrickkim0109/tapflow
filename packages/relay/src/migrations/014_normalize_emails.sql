-- Store email addresses in the form `normalizeEmail` (lib/email.ts) produces: spaces trimmed, ASCII
-- lowercased. Before this, `Alice@x.com` and `alice@x.com` could be two accounts, and login matched
-- case exactly.
--
-- A row whose normalized address another row already has, or would have, is left untouched: rewriting
-- it would violate `UNIQUE(email)`, abort this migration, and with it the relay's boot. The relay logs
-- those groups at startup so an Admin can remove the duplicate.
UPDATE users SET email = lower(trim(email))
WHERE email <> lower(trim(email))
  AND NOT EXISTS (
    SELECT 1 FROM users other
    WHERE other.id <> users.id AND lower(trim(other.email)) = lower(trim(users.email))
  );

UPDATE invitations SET email = lower(trim(email))
WHERE email IS NOT NULL AND email <> lower(trim(email));
