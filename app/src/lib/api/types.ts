/**
 * TraderKirala API tipleri.
 *
 * Gövde `./schema.ts` içinde **üretilir** (kaynak: sunucunun `/openapi.json`),
 * bu dosya yalnızca yeniden dışa aktarır. Elle tip eklemeyin — sunucu şeması
 * değiştiğinde `npm run gen:api` çalıştırın ve derleyicinin gösterdiği
 * uyumsuzlukları giderin.
 */
export * from './schema';
