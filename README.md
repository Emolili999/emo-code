# emo-code v2

OpenRouter API ile çalışan masaüstü kodlama ajanı (Electron + JavaScript). Çalışma klasörünüzdeki dosyaları okuyabilir, düzenleyebilir ve terminal komutları çalıştırabilir. Kademeli izin modları ve Gece Mavisi teması ile donatılmıştır.

## Kurulum

Node.js ve npm kurulu olmalı.

```bash
cd emo-code-v2
npm install
npm start
```

Fedora'da gerekirse:

```bash
sudo dnf install -y nodejs npm bubblewrap
```

VS Code'da klasörü açıp terminalden `npm start` çalıştırabilir veya `.vscode/launch.json` içindeki yapılandırmayı F5 ile başlatabilirsin.

## İzin Yönetimi (Kademeli Modlar)

Üst çubuktan veya `/mode` komutuyla kolayca değiştirilebilir:

- **🛡️ Sıkı (Strict)**: Her komudu ve dosya işlemini sorar. Oturum izniyle atlama yapmaz; her işlemde tam denetim sağlar.
- **⚖️ Normal (Normal)**: Riskli kodlarda mutlaka uyarır ve onay ister; güvenli komutları oturum izniyle hatırlar.
- **🤖 Oto (Auto)**: Kendin karar ver modu. Güvenli komutları ve dosya değişikliklerini otomatik onaylar; riskli veya hassas işlemlerde kullanıcıya sorar.
- **⚡ Turbo (Turbo)**: Tüm kodlara izin ver. Tam otomatik otonom mod; soru sormadan komut ve kodları doğrudan çalıştırır.

## Değişiklik İnceleme (Diff & Review)

Oturumda yapılan dosya değişikliklerini ve farklarını incelemek için üst çubuktaki `📝 Değişiklikler` butonuna tıklayabilir veya `/diff` komutunu kullanabilirsin:
- Hangi dosyada kaç ekleme (`+`) ve silme (`-`) yapıldığını gösterir.
- Satır numaralı renkli diff görünümü (silinenler kırmızı, eklenenler yeşil).
- İstenen dosyayı tek tıkla geri alma (`undoFile`) veya tüm oturumu geri alma desteği.

## Temalar

- **Koyu (Gece)**
- **Gece Mavisi (Midnight Blue)**: Derin lacivert ve elektrik mavisi tonlarında gece modu
- **Açık (Sıcak Kağıt)**
- **Sisteme uy**

## İlk kullanım

1. Ayarlar'dan OpenRouter API anahtarını gir (https://openrouter.ai/keys). Anahtar mümkün olduğunda işletim sistemi güvenli depolamasıyla şifrelenir.
2. Üstte modeli seç veya model kimliğini yaz. Dosya değişikliği için araç çağırmayı destekleyen bir model kullan.
3. **Klasör seç** ile yalnızca ilgili proje klasörünü seç.
4. İsteğini yaz.

## Araçlar

`list_dir`, `read_file`, `glob`, `search_files`, `write_file`, `edit_file`, `multi_edit`, `run_command`, `web_fetch`, `todo_write`, `ask_user`.

## Güvenlik ve geri alma

- API anahtarı destekleniyorsa işletim sisteminin güvenli depolamasıyla şifrelenir; arayüz anahtarı almaz.
- Ev dizininin tamamı, kök dizin, sistem klasörleri ve belirli gizli dizinler çalışma alanı olarak reddedilir.
- Özel anahtar ve benzeri dosyalar modele gönderilmez. `.env` ve benzeri hassas dosyalar her seferinde onay ister.
- `web_fetch` yalnızca HTTP(S) kabul eder; yerel, özel, link-local, rezerve IPv4/IPv6 adresleri ve bu adreslere yönlendirmeler engellenir. Dış alan adlarının DNS yanıtları da denetlenir.
- Komutlar `bash` üzerinden çalışır. Komut kalıpları riskli işlemleri her zaman yakalayamayabileceğinden, onay vermeden önce komutu kontrol et. Mümkünse Ayarlar'da bubblewrap sandbox'ını etkinleştir; ağ erişimi varsayılan olarak kapalıdır.
- Araçların dosya değişiklikleri ve `run_command` sonrası tespit edilen proje dosyası farkları **Geri al** ile geri alınabilir. İkili dosyaların yedekleri bayt bazında korunur.
- Komut değişikliği izlemesi performans amacıyla `.git`, `node_modules`, `.venv`, `venv`, `vendor`, `dist`, `build` ve `coverage` dizinlerini taramaz. Dosya sayısı veya yedek boyutu sınırına takılan değişiklikler raporda açıkça belirtilir; bunlar her zaman geri alınamayabilir. Önemli projelerde komut çalıştırmadan önce Git commit/stash almak yine de önerilir.
- Geri alma, harici süreçlerin aynı dosyalara eşzamanlı yazdığı durumlarda tam bir işlem günlüğü garantisi vermez.

## Ayarlar

- **En fazla adım:** Bir kullanıcı isteğinde modelin araç döngüsüne izin verilen üst sınır.
- **Komut zaman aşımı:** Komut başına en fazla 600 saniye.
- **Sohbet bütçesi:** OpenRouter kullanım maliyetine göre harcama sınırına gelindiğinde bekleyen araç çağrıları ve yeni model istekleri durdurulur.
- **Bağlam üst sınırı:** 8.000–1.000.000 token. Modelin gerçek bağlam sınırı daha düşük olabilir.

## Komutlar

- `/help`: komut yardımını gösterir.
- `/init`: proje talimatları için `EMO.md` oluşturulmasını ister. Dosyaya yazabilmek için plan modu kapalı olmalıdır.
- `/plan`: salt okunur plan modunu açar/kapatır.
- `/mode <sıkı|normal|oto|turbo>`: izin modunu gösterir veya değiştirir.
- `/compact`: konuşmayı özetleyerek bağlamı küçültür.
- `/undo`: son geri alma grubunu geri yükler.
- `/clear`: sohbet mesajlarını temizler.
- `/model <ad>`: model seçer.

Sohbeti dışa aktarırken **JSON** (mesajlar/araç kayıtları) veya **Markdown** (okunabilir döküm) seçebilirsin.

## Testler

```bash
npm test
```

## Dosyalar

- `main.js`: pencere, IPC ve ajan döngüsü
- `preload.js`: arayüz ile ana süreç arasındaki güvenli köprü
- `lib/`: araçlar, güvenlik denetimleri, OpenRouter istemcisi, onay ve geri alma
- `renderer/`: arayüz
- `test/`: birim ve araç testleri

## Talimat dosyaları

Çalışma klasöründe varsa şu dosyalar okunup sistem bağlamına eklenir (ilk bulunan kullanılır):
`EMO.md`, `OR.md`, `AGENTS.md`.

## Yapay zekâ ile üretim beyanı

Bu projenin kaynak kodu ve simgesi (`assets/icon.png`) büyük ölçüde yapay zekâ ile üretilmiş, insan tarafından tasarlanıp düzenlenmiştir.

Mimari kararlar, istem (prompt) tasarımı, düzenleme, test ve doğrulama insan katkısıyla yapılmıştır. Bu projede üçüncü taraf marka, logo, karakter veya tanınmış bir eserin taklidi amaçlanmamıştır.

Yapay zekâ çıktılarının telif koruması ülkeden ülkeye değişebilir ve bazı hukuk düzenlerinde makine üretimi bölümler için koruma sınırlıdır. Bu durum kodu MIT lisansıyla paylaşmayı ve kullanmayı engellemez; yalnızca birebir kopyalamaya karşı ileri sürülebilecek hakların kapsamını etkileyebilir.

## Lisans

MIT — ayrıntılar için [LICENSE](LICENSE) dosyasına bakın.
Kullanılan üçüncü taraf bileşenlerin lisansları: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

