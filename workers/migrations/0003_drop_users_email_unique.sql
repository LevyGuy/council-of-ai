-- The unique email index was incorrect: the Auth0 access token doesn't
-- always carry an email claim, so every new signup inserted email='' and
-- collided with the first such row. Auth0 sub (users.id, the PK) is the
-- real identity key.

DROP INDEX IF EXISTS idx_users_email;
