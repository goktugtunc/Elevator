import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { txApi } from '@/lib/api';
import type { TxSubmitOut, UnsignedTxOut } from '@/lib/api/types';
import { userMessage } from '@/lib/errors';
import { debugError, debugLog } from '@/lib/log';
import { wallet } from '@/lib/wallet';

/**
 * Zincir üstü akışın tek motoru (gelistirme-notlari §5):
 *
 *   backend XDR üretir → cüzdan imzalar → imzalı XDR `POST /tx/submit`'e döner
 *
 * Gizli anahtar hiçbir adımda sunucuya gitmez. Sunucu `pending_tx_id` ile
 * işlemi kendi tarafında takip eder; gönderim yanıtı sözleşmenin yeni durumunu
 * da taşıdığı için çağıran taraf ek bir sorguya ihtiyaç duymaz.
 *
 * Sözleşme ekranı (fund/propose/settle/cancel), işlem açma (trade), cüzdan
 * ödemesi ve trustline hep bunu kullanır.
 */
export type OnchainPhase = 'idle' | 'building' | 'signing' | 'submitting' | 'done';

export interface OnchainResult extends TxSubmitOut {
  /** Sunucu işlemi kabul etti ve zincirde başarılı oldu. */
  ok: boolean;
}

export function useOnchainAction({
  build,
  onSuccess,
  invalidate,
}: {
  /** İmzalanacak işlemi sunucudan ister. */
  build: (input: void) => Promise<UnsignedTxOut>;
  onSuccess?: (result: OnchainResult) => void;
  /** Başarıdan sonra tazelenecek sorgu anahtarları. */
  invalidate?: unknown[][];
}) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<OnchainPhase>('idle');

  const run = useMutation({
    mutationFn: async (): Promise<OnchainResult> => {
      setPhase('building');
      const tx = await build();
      debugLog('onchain', `${tx.kind} XDR hazır`, { pending: tx.pending_tx_id, hash: tx.tx_hash });

      setPhase('signing');
      const signed = await wallet.signTransaction(tx.unsigned_xdr, {
        networkPassphrase: tx.network_passphrase,
        address: tx.source,
      });

      setPhase('submitting');
      const res = await txApi.submit(signed, tx.pending_tx_id);
      const ok = res.status === 'SUCCESS';
      if (!ok) {
        debugError('onchain', `${tx.kind} başarısız`, res);
      }
      return { ...res, ok };
    },
    onSuccess: (res) => {
      setPhase('done');
      // Başarısızlıkta da tazelenir: cüzdan imzaladığı işlemi kendisi de
      // yayınlayabildiği için "gönderemedim" demek "zincirde olmadı" demek
      // değil. Tazelemezsek ekran, zincirde çoktan olmuş bir şeyi olmamış
      // gibi gösteriyor ve kullanıcı ikinci kez denemeye çalışıyor.
      for (const key of invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
      onSuccess?.(res);
    },
    onError: () => {
      setPhase('idle');
      for (const key of invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
    },
  });

  return {
    run: () => run.mutate(),
    phase,
    busy: run.isPending,
    result: run.data ?? null,
    /** Cüzdan reddi, ağ hatası ya da zincirdeki kontrat hatası — tek metin. */
    error: run.isError
      ? userMessage(run.error)
      : run.data && !run.data.ok
        ? (run.data.contract_error ?? run.data.error ?? 'The transaction failed on-chain.')
        : null,
    reset: () => {
      setPhase('idle');
      run.reset();
    },
  };
}

/** İmza akışının hangi adımda olduğunu kullanıcıya anlatan metin. */
export function phaseLabel(phase: OnchainPhase): string {
  switch (phase) {
    case 'building':
      return 'Preparing the transaction…';
    case 'signing':
      return 'Waiting for your wallet signature…';
    case 'submitting':
      return 'Submitting to Stellar…';
    default:
      return '';
  }
}
