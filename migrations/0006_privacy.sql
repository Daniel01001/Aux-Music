-- Privacy clean-up: Aux doesn't need email addresses, so remove the ones collected so far.
UPDATE users SET email = NULL;
-- Google photos become opt-in: hide ones that were shown automatically (the person can turn it back on).
UPDATE users SET avatar = NULL WHERE avatar IS NOT NULL AND avatar = google_picture;
