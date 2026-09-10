/* Private, per-account/workspace/device backups. Legacy global state is never
 * read or automatically assigned to an account. See docs/RELIABILITY_RELEASE.md.
 */
import { withAppAuth } from '../lib/app-auth.mjs';
import { handleBackup } from '../lib/backup.mjs';

export default withAppAuth(async (req, { userId }) => {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: 'hyperkernel-sync', consistency: 'strong' });
  return handleBackup(req, { userId, store });
});

export const config = { path: '/api/sync' };
