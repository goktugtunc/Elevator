import { QueryClient } from '@tanstack/react-query';

/**
 * Tek QueryClient örneği.
 *
 * Kök düzende (`app/_layout.tsx`) yaratılmak yerine burada duruyor; çünkü
 * oturum store'unun da erişmesi gerekiyor: **hesap değiştiğinde önbellek
 * temizlenmeli.** Aksi hâlde sorgu anahtarları hesaba bağlı olmadığı için
 * (`['dashboard']`, `['users','me']`, `['wallet']`…) önceki cüzdanın verisi
 * yeni oturumda görünüyor. Bu yalnızca yanlış sayı göstermekle kalmıyor:
 * müşteri panelinin gövdesi trader panelinde çizilince `profile_checklist`
 * gibi role özgü alanlar undefined olup ekranı çökertiyor.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

/** Oturum değişimlerinde çağrılır — bekleyen sorgular iptal, önbellek sıfır. */
export function resetQueryCache(): void {
  queryClient.clear();
}
