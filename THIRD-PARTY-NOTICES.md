# Üçüncü Taraf Bildirimleri / Third-Party Notices

emo-code v2, aşağıdaki açık kaynak yazılımları kullanır. Her bileşen kendi
lisansı altında dağıtılır; bu dosya ilgili lisansların korunması ve bildirimi
için eklenmiştir.

## Çalışma zamanı bağımlılıkları

| Paket | Sürüm | Lisans | Proje |
| --- | --- | --- | --- |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | https://github.com/cure53/DOMPurify |
| marked | 12.0.2 | MIT | https://github.com/markedjs/marked |
| @types/trusted-types | 2.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |

### DOMPurify (MPL-2.0 OR Apache-2.0)

DOMPurify çift lisanslıdır; kullanıcı iki lisanstan birini seçebilir.
MPL-2.0 seçildiğinde, DOMPurify kaynak dosyalarında yapılan değişikliklerin
kaynağı da MPL-2.0 kapsamında açık olmalıdır. Bu proje DOMPurify'ı
değiştirmeden, npm üzerinden olduğu gibi kullanır.

- MPL-2.0 metni: https://www.mozilla.org/en-US/MPL/2.0/
- Apache-2.0 metni: https://www.apache.org/licenses/LICENSE-2.0

### marked (MIT)

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/marked)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/marked)

## Geliştirme bağımlılıkları

| Paket | Lisans | Proje |
| --- | --- | --- |
| electron | MIT | https://github.com/electron/electron |
| electron-builder | MIT | https://github.com/electron-userland/electron-builder |

## Paketlenmiş çalıştırılabilir dosyalar

Electron tabanlı dağıtımlar Chromium ve Node.js içerir. Bu bileşenlerin lisans
metinleri, dağıtım paketinin içinde şu dosyalarda yer alır:

- `LICENSE.electron.txt` — Electron ekosistemi bildirimleri
- `LICENSES.chromium.html` — Chromium ve içerdiği üçüncü taraf bileşenler

Bu dosyalar `electron-builder` tarafından otomatik olarak pakete eklenir ve
dağıtım sırasında kaldırılmamalıdır.

## Yapay zekâ beyanı

Projenin kaynak kodu ve simgesi (`assets/icon.png`) yapay zekâ ile üretilmiştir. Bu bölüm üçüncü taraf yazılım bildirimlerinden ayrıdır ve yalnızca şeffaflık amacıyla eklenmiştir.

Üretilen içerikte bilinçli olarak üçüncü taraf marka, logo, karakter veya tanınmış eser taklidi kullanılmamıştır.

## Not

Bu projede, yukarıda listelenenler dışında hiçbir üçüncü taraf kaynak kodu
kopyalanmamıştır. `lib/` altındaki modüller (glob, diff, webfetch, security,
context, checkpoints, exec, store) bağımlılıksız olarak bu proje için
yazılmıştır.
