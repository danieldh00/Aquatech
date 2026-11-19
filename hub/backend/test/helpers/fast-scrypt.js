// Wordt vóór elke testrun geladen (`node --import`, zie package.json): zet goedkope scrypt-kosten voor testaccounts (zie scryptParams in store.js).
process.env.AQUATECH_TEST_SCRYPT_N = process.env.AQUATECH_TEST_SCRYPT_N || '1024';
