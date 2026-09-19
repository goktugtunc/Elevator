import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';

import { TabBar } from '@/components/layout';
import { useSession } from '@/store/session';

/** Figma "Tab Bar/Müşteri": Panel · Hareketler · Keşfet · İlanlarım · Profil */
export default function CustomerLayout() {
  const { status, role } = useSession();
  if (status !== 'signed_in') return <Redirect href="/(auth)/login" />;
  if (role !== 'customer') return <Redirect href="/" />;

  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="panel" />
      <Tabs.Screen name="hareketler" />
      <Tabs.Screen name="kesfet" />
      <Tabs.Screen name="ilanlarim" />
      <Tabs.Screen name="profil" />
    </Tabs>
  );
}
