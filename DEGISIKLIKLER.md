# emo-code v2 - Geliştirme Notları

## v2.1 Yenilikleri

### 1. Enter ile Onaylama
- Ajan onay istediğinde artık sadece mouse ile tıklamak gerekmiyor: bekleyen onay kartı varken **Enter** tuşuna basmak işlemi onaylar.
- Onay kartı ekranda beklerken "İzin ver" düğmesi `İzin ver (Enter)` olarak etiketlenir ve ipucu gösterilir.
- Giriş alanı boşken Enter'a basmak da onaylar; giriş alanında yazı varsa Enter mesajı gönderir (çakışma yok).
- Ayarlar/Değişiklikler penceresi açıkken veya bir metin alanına yazarken Enter onayı devre dışıdır.
- Aynı onay kartı iki kez yanıtlanamaz (çift tıklama/çift Enter koruması). Yanıt verilen kart artık bekleyen onay sayılmaz.

### 2. Mod Simgeleri Kaldırıldı
- İzin modu seçicide (`Sıkı`, `Normal`, `Oto`, `Turbo`) ve Ayarlar penceresindeki mod radyo kartlarında **emoji/simge** kaldırıldı; yalnızca yazılar kaldı.
- Onay kartındaki mod rozeti de simgesiz gösterilir (`Normal mod` gibi).
- `/mode` komut çıktısı da simgesiz metinle yazılır.

## v2.0 Yenilikleri

### 1. Kademeli İzin Yönetimi
- 4 kademeli izin yönetim sistemi eklendi:
  - **Sıkı (strict)**: Her komudu ve dosya işlemini sorar. Oturum izni ile atlama yapmaz; tam denetim sağlar.
  - **Normal (normal)**: Riskli komut ve kodlarda mutlaka uyarı verir ve onay ister; güvenli komutları oturum izniyle hatırlar.
  - **Oto (auto)**: Kendin karar ver modu. Güvenli komutları ve dosya düzenlemelerini doğrudan otomatik onaylar; riskli veya hassas işlemlerde kullanıcıya sorar.
  - **Turbo (turbo)**: Tüm kodlara ve komutlara sormadan doğrudan izin verir (tam otomatik otonom mod).
- **Üst Çubuk İzin Seçicisi**: Arayüzün üst çubuğuna tek tıkla mod değiştiren modern açılır menü (`🛡️ Sıkı`, `⚖️ Normal`, `🤖 Oto`, `⚡ Turbo`) eklendi.
- **Ayarlar Modalı Entegrasyonu**: Ayarlar penceresinde her modun açıklamasını içeren 4'lü radyo kart seçici eklendi.
- **`/mode` Slash Komutu**: Sohbet alanından `/mode <sıkı|normal|oto|turbo>` komutuyla doğrudan izin modu değiştirilebilir.
- **Onay Kartı Geliştirmeleri**: Onay kartlarında aktif izin modu rozeti ve riskli işlemlerde vurgulanmış uyarı kutusu (`⚠️ Riskli İşlem Uyarısı`) gösterilir.

### 2. Gece Mavisi (Midnight Blue) Teması
- Derin gece mavisi paleti eklendi (`#0b0f19` arka plan, `#070a12` kenar çubuğu, `#131b2e` kartlar ve `#3b82f6` elektrik mavisi vurgular).
- Ayarlar penceresindeki tema seçicisine ve CSS değişkenlerine (`data-theme="midnight"`) entegre edildi.
- Electron pencere açılış arka plan rengi seçilen temaya uyum sağlayacak şekilde dinamik hale getirildi.

### 3. Değişiklik İnceleme (Diff & Review) Arayüzü
- Oturum boyunca hangi dosyalarda ne kadar değişiklik yapıldığını (`+eklenen`, `-silinen`), hangi satırların silinip eklendiğini detaylı gösteren iki panelli inceleme penceresi eklendi.
- **Üst Çubukta Canlı Rozet**: Oturumda yapılan dosya değişiklik sayısı ve satır farklarını gösteren `📝 Değişiklikler (+X -Y)` butonu eklendi.
- **Detaylı Satır Numaralı Diff**: Silinen satırlar kırmızı (`-`), eklenen satırlar yeşil (`+`) ve değişmeyen satırlar bağlam katlama desteğiyle gösterilir.
- **Tekil Dosya Geri Alma (`undoFile`)**: Diğer değişiklikleri bozmadan yalnızca tek bir dosyadaki değişiklikleri önceki haline döndürebilme özelliği eklendi.
- **Hızlı Erişim**: `/diff` ve `/changes` slash komutları ile karşılama ekranındaki hızlı komut hapları entegre edildi.

## Güvenlik ve doğruluk

- Riskli onaylarda `allow_session` kararı artık kabul edilmiyor; normal oturum izni hassas/riskli işlemlere uygulanamıyor.
- `web_fetch` özel/rezerve IPv4 aralıklarını, IPv4-mapped IPv6 biçimlerini, IPv6 yerel/özel aralıklarını, 6to4/Teredo gibi geçiş aralıklarını reddediyor. Alan adının DNS sonuçları denetleniyor ve gerçek HTTP bağlantısı doğrulanmış IP'ye sabitlenerek DNS tekrar çözümlemesi kaynaklı yönlendirme riski azaltılıyor. Her yönlendirme yeniden doğrulanıyor.
- Geri alma yedekleri metin yerine Buffer olarak tutuluyor; binary dosyaların baytları ve dosya izinleri korunuyor.
- `run_command` öncesi/sonrası çalışma alanı farkı kaydediliyor. Dosya oluşturma, değiştirme ve silme işlemleri mümkün olduğunda `/undo` ile geri alınabiliyor.
- Harcama sınırı model kullanım bilgisi alındıktan hemen sonra kontrol ediliyor. Sınır aşılırsa bekleyen araç çağrıları çalıştırılmıyor ve yeni model istekleri başlamıyor. Tek bir tamamlanmış model isteğinin bedeli ancak sonradan bilindiğinden tek istek sınırı aşabilir.
- Akış yarıda durdurulduğunda kısmi metin sohbet geçmişinde korunuyor; yarım kalmış araç çağrıları çalıştırılmıyor.

## Arayüz ve belgeler

- Bağlam token üst sınırı artık Ayarlar ekranından değiştirilebilir.
- Sohbeti JSON veya Markdown olarak dışa aktarma seçeneği eklendi.
- Plan modu açıkken `/init` komutu dosyaya yazılamayacağını açıklıyor.
- README araç listesini, güvenlik önlemlerini, geri alma sınırlamalarını ve test komutunu güncelledi.

## Geri alma kapsamı

Performans ve disk kullanımı için `.git`, `node_modules`, `.venv`, `venv`, `vendor`, `dist`, `build` ve `coverage` dizinleri komut farkı taramasına dahil değildir. Çalışma alanı başına 10.000 dosya, toplam 25 MiB snapshot içeriği ve tek dosya başına 10 MiB yedek sınırları vardır. Bu sınırlar aşılırsa uygulama geri alınamayan değişiklikler için uyarı ekler. Git commit/stash yine de önerilir.

## Doğrulama

- `npm test`: **42 test geçti, 0 test başarısız**.
- JavaScript kaynakları için `node --check` çalıştırıldı.
- Electron grafik arayüzü uçtan uca başlatılıp test edilmedi; değişiklikler birim testleri, araç entegrasyon testleri ve sözdizimi kontrolüyle doğrulandı.
