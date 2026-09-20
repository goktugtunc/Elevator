import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Klavyenin kapladığı yükseklik (kapalıyken 0).
 *
 * Neden `KeyboardAvoidingView` yetmiyor: Android'de `behavior` verilmezse bileşen
 * hiçbir şey yapmaz ve pencerenin kendiliğinden küçülmesine (adjustResize)
 * güvenir. Expo SDK 54+ ise **edge-to-edge**'i varsayılan yapıyor; edge-to-edge
 * açıkken pencere küçülmüyor, boşluğu uygulamanın kendisi vermesi gerekiyor.
 *
 * Değer olduğu gibi kullanılır, `insets.bottom` **çıkarılmaz**: edge-to-edge'de
 * içerik zaten gezinme çubuğunun altına kadar uzandığı için o pay klavye
 * yüksekliğinin içinde. Bu cihazda çıkarma, yazma alanını klavyenin altında
 * bırakan 48 dp'lik eksik boşluğa yol açıyordu.
 *
 * `endCoordinates.screenY` cazip görünüyor ama **ekran** koordinatı; pencere
 * yüksekliği durum çubuğunu içermediğinden ikisini çıkarmak yanlış sonuç verir.
 *
 * Expo Go ile uyumludur; ek native modül gerektirmez.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    // iOS'ta `will*` animasyonla eş zamanlı gelir, Android'de yalnızca `did*` var.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(showEvent, (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}
