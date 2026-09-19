import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';

import { TabBar } from '@/components/layout';
import { useSession } from '@/store/session';

/** Figma "Tab Bar/Trader": Panel · İşlemler · Keşfet · İlanlarım · Profil */
export default function TraderLayout() {
  const { status, role } = useSession();
  if (status !== 'signed_in') return <Redirect href="/(auth)/login" />;
  if (role !== 'trader') return <Redirect href="/" />;

  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="panel" />
      <Tabs.Screen name="islemler" />
      <Tabs.Screen name="kesfet" />
      <Tabs.Screen name="ilanlarim" />
      <Tabs.Screen name="profil" />
    </Tabs>
  );
}
