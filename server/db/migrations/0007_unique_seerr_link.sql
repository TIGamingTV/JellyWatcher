-- 0.8.0: a Seerr account belongs to at most one JellyWatcher account. Two accounts linked to the same
-- Seerr user made requests synced from Seerr land on either of them. Existing duplicates keep the
-- oldest link; the others are unlinked and can be linked again by an administrator.
UPDATE users SET seerr_user_id = NULL, seerr_username = NULL, seerr_permissions = NULL
 WHERE seerr_user_id IS NOT NULL
   AND id > (SELECT MIN(u2.id) FROM users u2 WHERE u2.seerr_user_id = users.seerr_user_id);

CREATE UNIQUE INDEX users_seerr_user_unique ON users(seerr_user_id) WHERE seerr_user_id IS NOT NULL;
