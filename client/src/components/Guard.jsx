import { useAuth } from '../auth/AuthProvider.jsx';
import { Callout } from './ui.jsx';

/** Route-level permission guard (the API enforces the same rules). */
export function Guard({ perm, role, children }) {
  const { user, can } = useAuth();
  const ok = (!perm || can(...[].concat(perm))) && (!role || [].concat(role).includes(user.role));
  if (!ok) return <div className="max-w-xl"><Callout tone="alert" title="You do not have permission to view this page.">If you need access, ask an administrator to update your role.</Callout></div>;
  return children;
}
