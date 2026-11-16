// Role-based landing page after login (UC-01 post-condition).
export const roleHome = (role) => (role === 'patient' ? '/portal' : '/dashboard');
