import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';

/**
 * Route table. Each entry lazily loads one page module; feature owners edit only their own pages.
 * Public pages: /, /how-it-works, /pricing, /support, /privacy, /terms, /account-deletion, /contact
 * Parent portal: /app/*   Owner admin: /admin/*
 */
const page =
  (loader: () => Promise<{ default: ComponentType }>): RouteObject['lazy'] =>
  async () => ({ Component: (await loader()).default });

export const routes: RouteObject[] = [
  { path: '/', lazy: page(() => import('./pages/public/LandingPage.tsx')) },
  { path: '/how-it-works', lazy: page(() => import('./pages/public/HowItWorksPage.tsx')) },
  { path: '/pricing', lazy: page(() => import('./pages/public/PricingPage.tsx')) },
  { path: '/support', lazy: page(() => import('./pages/public/SupportPage.tsx')) },
  { path: '/privacy', lazy: page(() => import('./pages/public/PrivacyPage.tsx')) },
  { path: '/terms', lazy: page(() => import('./pages/public/TermsPage.tsx')) },
  { path: '/account-deletion', lazy: page(() => import('./pages/public/AccountDeletionPage.tsx')) },
  { path: '/contact', lazy: page(() => import('./pages/public/ContactPage.tsx')) },
  { path: '/app', lazy: page(() => import('./pages/app/FamilyDashboardPage.tsx')) },
  { path: '/app/children', lazy: page(() => import('./pages/app/ChildrenPage.tsx')) },
  { path: '/app/devices', lazy: page(() => import('./pages/app/DevicesPage.tsx')) },
  { path: '/app/security', lazy: page(() => import('./pages/app/SecurityPage.tsx')) },
  { path: '/app/guardians', lazy: page(() => import('./pages/app/GuardiansPage.tsx')) },
  { path: '/app/privacy', lazy: page(() => import('./pages/app/PrivacyControlsPage.tsx')) },
  { path: '/app/rewards', lazy: page(() => import('./pages/app/RewardsPage.tsx')) },
  { path: '/app/homework', lazy: page(() => import('./pages/app/HomeworkPage.tsx')) },
  { path: '/app/learning', lazy: page(() => import('./pages/app/LearningPlannerPage.tsx')) },
  { path: '/app/school', lazy: page(() => import('./pages/app/SchoolAndPromotionsPage.tsx')) },
  { path: '/admin', lazy: page(() => import('./pages/admin/AdminHomePage.tsx')) },
  { path: '/admin/promotions', lazy: page(() => import('./pages/admin/PromotionsAdminPage.tsx')) },
  { path: '/admin/schools', lazy: page(() => import('./pages/admin/SchoolsAdminPage.tsx')) },
  { path: '*', lazy: page(() => import('./pages/public/NotFoundPage.tsx')) },
];
