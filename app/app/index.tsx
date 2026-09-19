import { Redirect } from 'expo-router';

import { useSession } from '@/store/session';

/**
 * Giriş noktası — oturum durumuna göre yönlendirir.
 *   onboarding görülmedi → /(auth)/onboarding
 *   oturum yok           → /(auth)/login
 *   oturum var, rol yok  → /(auth)/register/role   (cüzdan bağlı ama kayıtsız)
 *   müşteri              → /(customer)/panel
 *   trader               → /(trader)/panel
 */
export default function Index() {
  const { status, role, onboardingSeen } = useSession();

  if (!onboardingSeen) return <Redirect href="/(auth)/onboarding" />;
  if (status !== 'signed_in') return <Redirect href="/(auth)/login" />;
  if (role === 'customer') return <Redirect href="/(customer)/panel" />;
  if (role === 'trader') return <Redirect href="/(trader)/panel" />;
  return <Redirect href="/(auth)/register/role" />;
}
