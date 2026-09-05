/**
 * Switches the admin second factor off for one test file.
 *
 * This is a module rather than a line at the top of the test because ESM hoists
 * imports above statements: anything the test imports would otherwise read the
 * config — which is frozen the first time it is imported — before the
 * assignment ran. Imported *first*, its side effect happens before the module
 * that reads the variable is ever loaded.
 */
process.env.ADMIN_MFA_REQUIRED = 'false';
