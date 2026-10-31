# Değişiklikler

## 3.1.0 — v2 serisine göre

### Ajan ve araçlar

- `web_search`, kalıcı kabuk oturumu, arka plan süreçleri, salt okunur Git işlemleri ve salt okunur alt ajan keşfi eklendi.
- Komut çıktısı sınırları, zaman aşımı ve iptal davranışı geliştirildi. Linux'ta komutlar Bash, Windows'ta PowerShell üzerinden çalışır; Bubblewrap bulunan Linux sistemlerinde sandbox ağ erişimi kapalı çalışabilir.
- Uzun bağlamlar için eski araç çıktıları ve görseller kademeli olarak elenir; API'nin bildirdiği reasoning ayrıntıları desteklenir.
- Model yanıtı token sınırında kesildiğinde yarım araç çağrıları çalıştırılmaz. Tekrarlanan araç çağrıları ve alt ajan bütçesi sınırlandırılır.

### Dosyalar, ekler ve geri alma

- Görsel ekler sohbet kaydında base64 olarak tutulmak yerine içerik özetiyle ilişkilendirilmiş dosyalara taşınır; API isteği sırasında çözümlenir.
- Görsel dosyalar tür ve boyut bakımından denetlenir. PDF ekleri saklanabilir; PDF içeriği modele gönderilmez.
- Komutların oluşturduğu, değiştirdiği veya sildiği dosyalar için sınırlı geri alma snapshot'ları alınır; ikili dosyalar bayt ve izin bilgileriyle korunur.
- Dosya değişikliklerini inceleme, dosya bazında geri alma ve onay akışı iyileştirildi.

### Güvenlik ve sağlamlık

- `web_fetch` özel/rezerve IP adreslerini, DNS yönlendirmelerini ve güvensiz yönlendirmeleri engelleyecek şekilde sıkılaştırıldı.
- İzin modları ve onayların oturum kapsamı güçlendirildi; hassas dosya ve komut korumaları genişletildi.
- Tek uygulama örneği kilidi, beklenmeyen hata raporlama ve uygulama kapanırken arka plan süreçlerini temizleme eklendi.

### Arayüz ve ayarlar

- Görsel ekleme, yeni araçlara arayüz desteği ve bağlam sınırı ayarı eklendi.
- Onay kartında Enter ile yanıt verme ve sadeleştirilmiş izin modu etiketleri sunuldu.

### Geliştirme ve doğrulama altyapısı

- IPC, güvenlik, araçlar, ekler ve yardımcı modüller için test kapsamı genişletildi.
- Ana süreç, preload ve `lib/` için kapsama eşikleri; Linux'ta Electron UI smoke testi; Windows'ta paket derleme ve renderer başlangıç kontrolü eklendi.

### Bilinen sınırlar

- PDF içeriği modele iletilmez.
- Komut değişiklikleri için geri alma taraması `.git`, bağımlılık ve derleme klasörlerini dışarıda bırakır; dosya sayısı ve yedek boyutu sınırlıdır.
- Windows başlangıç smoke testi paketin renderer sayfasını açtığını kontrol eder; tam etkileşimli UI akışı Linux smoke testinde çalışır.
