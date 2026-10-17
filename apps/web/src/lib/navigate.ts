/** Opens an in-app route from code that has no router hook (menus, settings panels). AppShell performs the navigation. */
export const navigateTo = (to: string) => window.dispatchEvent(new CustomEvent('jorcord:navigate', { detail: { to } }));
