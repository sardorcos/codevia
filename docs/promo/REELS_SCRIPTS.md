# Промо-ролики для Instagram Reels

Ролики делаются только для приложений, которые опубликованы в App Store или ждут проверки. Статусы взяты из App Store Connect 21.11.2026 через workflow `asc-status` в Codemagic.

| Приложение | Статус в App Store Connect | Версия |
|---|---|---|
| **Block Order — Calm Puzzle** | Опубликовано (Ready for Distribution) | 1.0.0 |
| **DAMKA — Offline Checkers** | Опубликовано (Ready for Distribution) | 1.4.1 |
| **Parking Exit: Car Puzzle** | На проверке (Waiting for Review) | 1.1.0 |

Остальные 21 приложение в статусе Prepare for Submission (только TestFlight), поэтому для них роликов нет.

---

## Общий стандарт (одинаковый для всех трёх роликов)

- **Формат:** 9:16, 1080×1920, 30 fps, длина 45 с. Озвучки нет; звук — только музыка и звуковые акценты, вшитые в трек.
- **Безопасные зоны Reels:** текст не ставим в верхние 250 px и нижние 420 px (там подпись и кнопки Instagram), справа оставляем 120 px под иконки.
- **Структура «крупной студии»:**
  1. **Хук, 0–3 с.** Самый эффектный кадр сразу, без логотипа.
  2. **Эскалация, 3–30 с.** Механика, нарастание и 3 ключевые фишки игры.
  3. **Кульминация, 30–38 с.** Победа, взрыв эмоции и музыкальный дроп.
  4. **Пэкшот, 38–45 с.** Иконка, название, подзаголовок и бейдж «Загрузите в App Store».
- **Монтаж по биту.** Каждая склейка и каждое появление текста ставятся на сильную долю, а на дропе идут склейки на каждую долю.
- **Типографика.** Короткие строки до 4 слов, анимация kinetic type (маска снизу вверх, 6–8 кадров, ease-out), лёгкий motion blur и тень 20 % для читаемости.
- **Честность рекламы.** Игровой экран в роликах — это **реальная запись геймплея** (с симулятора или iPhone, 15–20 с на игру), вставленная в 3D-мокап iPhone. AI-клипы Higgsfield используются только для кинематографичных сцен: мир игры, фишки и машина крупным планом, атмосфера. Так ролик выглядит как у Supercell или Playrix и при этом не обещает того, чего нет в игре (это требование и Meta Ads, и App Store).

### Производственный пайплайн в Higgsfield (на каждый ролик)

| Шаг | Инструмент | Параметры |
|---|---|---|
| 1. Кадр-референс | иконка 1024 px из репозитория → `media_upload` | роль `image_references` |
| 2. Видео: 3 клипа по 15 с | `generate_video`, модель `seedance_2_5`, режим `omni_reference` | 9:16, 1080p, `generate_audio: false` |
| 3. Музыка, 45 с | `generate_audio` (музыкальная модель) | BPM и жанр из сценария, без вокала |
| 4. Сборка, титры, бит-синк | workflow `video-montage` / `video-editing` (Higgsedit) | шрифты и тайминги из сценария |

**Оценка стоимости:** 1 клип 15 с в 1080p стоит 240 кредитов (Seedance 2.5) или 180 (Seedance 2.0). На ролик уходит около 720 кредитов плюс музыка, на три ролика — **≈ 2 200–2 400 кредитов**.

---

## 1. Block Order — Calm Puzzle (опубликовано)

**Идея:** «Тишина, которая затягивает». Антистресс-эстетика в духе Apple: чистые формы, мягкий свет, идеальный ASMR-ритм. Фирменная фраза игры: *«Всё встаёт на свои места»*.

- **Палитра:** фон #F4F5F7, стальной синий #346B97 / #4284AD, глубокий зелёный #186A58, акцент белый с мягким свечением.
- **Шрифты:** **Clash Display Semibold** (Fontshare, бесплатный) для заголовков, **Manrope Medium** для подписей. Только строчные буквы с крупным трекингом: это выглядит дорого и спокойно.
- **Музыка:** минималистичный melodic house / chill electronic, 112 BPM, без вокала. Мягкие маримбы и пэды, перкуссия «щелчки дерева». На 30 с — дроп с глубоким басом и арпеджио. Звуковые акценты: «клик» при постановке блока и стеклянный «дзынь» при очистке линии.
  > Промпт для музыки: *minimal melodic house, 112 bpm, soft marimba, warm pads, wooden click percussion, satisfying and calm, builds gently, deep bass drop at 30 seconds, clean ending at 45 seconds, no vocals*

| Время | Кадр | Текст на экране | Монтаж |
|---|---|---|---|
| 0.0–2.5 | **Хук.** Макро: синий 3D-блок с мягкими гранями медленно падает в последнюю пустую ячейку и встаёт с идеальным «клик», после чего вся линия вспыхивает белым и растворяется частицами | **«идеально.»** | Склейка на «клик», затем 2 кадра белой вспышки |
| 2.5–6 | Камера пролетает над доской 8×8, как над архитектурным макетом; блоки синие и зелёные, мягкие тени | **«8×8. три фигуры.»** | Плавный dolly-in |
| 6–12 | Мокап iPhone: **реальный геймплей**, палец перетаскивает фигуры из лотка | **«без таймера»** → **«без спешки»** | Смена текста на каждый такт |
| 12–18 | Каскадом заполняются 2 ряда и колонка; ячейки подсвечиваются перед очисткой | **«всегда есть ход»** | Speed ramp 100 % → 40 % → 100 % |
| 18–24 | Двойная очистка линий; поверх всплывает **STREAK ×3** большим объёмным шрифтом | **STREAK ×3** | Удар на сильную долю, лёгкая тряска камеры |
| 24–30 | Кнопка «отмена»: время отматывается назад, блоки летят обратно в лоток | **«ошибся? отмени.»** | Эффект перемотки, звук rewind в треке |
| 30–36 | **Дроп.** Монтаж по долям: 6 очисток подряд с разных ракурсов, взрыв синих и зелёных конфетти, **NEW BEST** | **NEW BEST** | Склейка на каждую долю |
| 36–39 | Пустая чистая доска, блоки медленно оседают | **«всё встаёт на свои места.»** | Затухание на пэде |
| 39–45 | **Пэкшот.** Иконка на светлом фоне, блоки собираются в логотип | **Block Order** / *calm puzzle* / бейдж App Store / «Бесплатно. Без рекламы.» | Иконка влетает с bounce |

**Промпты Higgsfield** (Seedance 2.5, 9:16, иконка как `image_references`):
- **Клип A, 0–15 с:** *Macro cinematic product shot of a minimalist puzzle board, 8x8 grid of soft matte cells on off-white #F4F5F7 background, steel-blue #346B97 and deep green #186A58 rounded cubes. Shot 1: a blue cube slowly drops into the last empty slot and snaps perfectly, the whole row flashes white and dissolves into tiny glowing particles. Shot 2: slow drone fly-over across the board like an architectural model, soft studio light, long shadows. Shot 3: three new pieces float above the board. Apple-commercial aesthetic, shallow depth of field, ultra clean, satisfying ASMR feel.*
- **Клип B, 15–30 с:** *Same board and style. Rows and columns fill in a cascade, cells glow before clearing, double line clear explodes into soft particles, a rewind effect pulls blocks back into a tray, smooth speed ramps, calm satisfying rhythm.*
- **Клип C, 30–45 с:** *Same style. Rapid sequence of satisfying line clears from different camera angles, burst of blue and green confetti, the board empties and pieces gently settle, final slow pull-back to a clean empty board, studio light.*

---

## 2. DAMKA — Offline Checkers (опубликовано)

**Идея:** «Ход королей». Эпичный кинотрейлер с премиальной эстетикой шахматного клуба: мрамор, золото, слоновая кость. Шашки — как герои фильма, а кульминация — превращение в дамку с золотой короной.

- **Палитра:** нефритово-зелёный мрамор #0B3A2C / #1B5E3F, золото #D4AF37 / #E3BE7A, слоновая кость #F3E9D2, графит #1C1C1C.
- **Шрифты:** **Cinzel Bold** (Google Fonts) для заголовков, с золотым градиентом и бликом, пробегающим по буквам; **Montserrat Medium** для подписей.
- **Музыка:** эпичный cinematic hybrid trailer, 90 BPM. Пиано-остинато на старте, затем струнные, тайко и брасс. Тишина на 0.5 с перед дропом, а на «Дамка!» — мощный удар, хор и брасс. Акценты: звонкий удар фишки о доску и «whoosh» при взятиях.
  > Промпт для музыки: *epic cinematic hybrid trailer music, 90 bpm, starts with a tense piano ostinato, builds with staccato strings and taiko drums, half-second silence at 29 seconds, massive brass and choir hit at 30 seconds, regal and triumphant, ends on a sustained chord at 45 seconds, no vocals*

| Время | Кадр | Текст на экране | Монтаж |
|---|---|---|---|
| 0.0–3 | **Хук.** Сверхмакро: чёрная шашка с размаху бьёт по мраморной доске, разлетаются золотые искры и пыль, slow-mo 240 fps | **«Один ход.»** | Удар на первой доле |
| 3–7 | Камера скользит по полю: ряды белых и чёрных шашек, как армии перед битвой, контровой свет | **«Две армии.»** | Медленный dolly по уровню доски |
| 7–13 | Мокап iPhone: **реальный геймплей**, игрок делает первые ходы против компьютера | **«Русские и английские шашки»** | Склейка на такт |
| 13–19 | Кинематографичная **цепочка взятий**: белая шашка прыгает 3 раза, и каждая взятая чёрная разлетается в золотую пыль | **«Двойной удар»** → **«Тройной удар»** | Speed ramp на каждом прыжке |
| 19–24 | Мокап: экран «Задача дня» и решение комбинации | **«Задача дня»** / «Отдай, чтобы взять» | Жёсткие склейки |
| 24–29 | Быстрая смена тем доски: Классика → Нефрит → Графит → Слоновая кость | **«Играй без интернета»** | Wipe-переходы на каждую долю |
| 29–29.5 | Тишина, чёрный кадр | — | Пауза перед дропом |
| 29.5–36 | **Дроп.** Шашка достигает последнего ряда, сверху опускается **золотая корона** и вплавляется в фишку, золотая ударная волна, хор | **«ДАМКА!»** огромным Cinzel, трещина-блик по буквам | Удар на тайко, flash-frame |
| 36–39 | Мокап: экран **«Вы победили!»** | **«Вы победили!»** | Быстрый zoom-in |
| 39–45 | **Пэкшот.** Иконка DAMKA, золотые частицы, мраморный фон | **DAMKA** / *Offline Checkers* / бейдж App Store / «RU · EN · UZ» | Блик пробегает по иконке |

**Промпты Higgsfield** (Seedance 2.5, 9:16, иконка как `image_references`, `genre: epic` для Seedance 2.0):
- **Клип A, 0–15 с:** *Epic cinematic trailer, luxury checkers game. Shot 1: extreme macro slow motion of a black metallic checker piece slamming onto a dark green marble board with gold inlays, golden sparks and dust burst. Shot 2: low camera dolly along the board revealing rows of ivory and black checkers like two armies, dramatic rim light, volumetric haze. Shot 3: an ivory checker with embossed details glides forward. Rich colors: emerald marble #0B3A2C, polished gold, ivory, graphite. Photoreal, 8k detail, shallow depth of field.*
- **Клип B, 15–30 с:** *Same board and style. An ivory checker performs a triple capture, leaping three times; each captured black piece shatters into golden dust in slow motion. Then the board material morphs: green marble to jade to graphite to ivory. Dramatic lighting, high-end commercial.*
- **Клип C, 30–45 с:** *Same style. An ivory checker reaches the last row; a golden crown descends from above and melts into its surface, becoming the embossed crown emblem, a golden shockwave ripples across the board, particles rise, slow triumphant pull-back, regal mood.*

---

## 3. Parking Exit: Car Puzzle (на проверке)

> Публиковать ролик лучше после того, как Apple одобрит версию 1.1.0: реклама приложения, которое ещё нельзя скачать, сжигает охват.

**Идея:** «Выберись из пробки». Энергичный экшн, будто тизер гоночной игры, но это головоломка. Закатный город, глянцевая красная машина-герой и единственный выезд.

- **Палитра:** мокрый асфальт #1E2229, глянцевый красный #E8231B, неоновый янтарь #FFB53A (стрелка и подсветка выезда), зелень #5DBB3F, закатный оранжевый #FF7A2F.
- **Шрифты:** **Anton** (Google Fonts) для заголовков: заглавные, наклон 8°, жёлтая обводка и эффект «скорости» (motion streak); **Roboto Condensed Bold** для подписей (тот же шрифт, что в игре).
- **Музыка:** энергичный electro-funk / future-house, 124 BPM. Слэп-бас, синты, гитарные риффы, звуки мотора и шин в треке. Дроп на 30 с.
  > Промпт для музыки: *energetic electro funk future house, 124 bpm, slap bass, punchy drums, retro synth stabs, car engine rev and tire screech sound design accents, sunset city vibe, build-up from 24 seconds, big drop at 30 seconds, ends with a clean hit at 45 seconds, no vocals*

| Время | Кадр | Текст на экране | Монтаж |
|---|---|---|---|
| 0.0–2.5 | **Хук.** Вид сверху: красная машина зажата со всех сторон, рёв мотора, фары вспыхивают | **«ТЫ В ЛОВУШКЕ.»** | Резкий zoom-in на долю |
| 2.5–6 | Дрон взлетает над закатной парковкой: десятки машин, один выход справа, светится янтарная стрелка | **«ВЫХОД — ОДИН.»** | Whip-pan |
| 6–12 | Мокап iPhone: **реальный геймплей**, свайпы двигают машины вперёд и назад по полосам | **«ДВИГАЙ МАШИНЫ»** | Склейки на каждый такт |
| 12–17 | Подсказка: заблокировавшие машины подсвечиваются янтарным контуром | **«ПОДСКАЗКИ — БЕСПЛАТНО»** | Glitch-переход |
| 17–24 | Кинематографично: машины одна за другой отъезжают, освобождая коридор; блики на кузовах | **«КАЖДЫЙ ХОД НА СЧЕТУ»** + счётчик ходов | Speed ramp |
| 24–30 | Build-up: коридор свободен, камера опускается к красной машине, обороты мотора растут | **«КОРИДОР СВОБОДЕН…»** | Ускорение склеек |
| 30–35 | **Дроп.** Красная машина вылетает через выезд, янтарный след, визг шин, искры, вспышка | **«ПОЕХАЛИ!»** | Удар, тряска камеры, flash-frame |
| 35–39 | Мокап: **«Уровень пройден!»**, затем дрон над городом и карта, которая открывается квартал за кварталом | **«24 УРОВНЯ · ВЕСЬ ГОРОД»** | Wipe по дороге |
| 39–45 | **Пэкшот.** Иконка: машина и светящаяся стрелка | **PARKING EXIT** / *Car Puzzle* / бейдж App Store | Машина проезжает и «вытягивает» логотип |

**Промпты Higgsfield** (Seedance 2.5, 9:16, иконка как `image_references`):
- **Клип A, 0–15 с:** *High-energy cinematic top-down shot of a glossy red sports car #E8231B trapped in a packed parking lot at golden sunset, cracked dark asphalt, stone curbs, green bushes. Shot 1: fast zoom-in, the red car's headlights flash, engine rev. Shot 2: drone rises revealing dozens of cars and a single exit on the right with a glowing amber arrow. Shot 3: cars begin sliding forward and backward along their lanes. Stylized realistic mobile game look, warm sunset rim light, vibrant colors, dynamic camera.*
- **Клип B, 15–30 с:** *Same parking lot and style. Blocking cars outlined with glowing amber light slide away one by one, opening a corridor, reflections on glossy car bodies, camera lowers to the red car as the engine revs louder, tension building.*
- **Клип C, 30–45 с:** *Same style. The red car launches through the single exit leaving an amber light trail, tire smoke and sparks, bright flash, then drone flies up over a sunset city map as districts light up one by one, triumphant energetic mood.*

---

## Чек-лист перед публикацией

- [ ] Записать 15–20 с реального геймплея каждой игры (симулятор iPhone 16 Pro Max → File → Record Screen).
- [ ] Бейдж «Загрузите в App Store» брать только официальный, с [developer.apple.com/app-store/marketing/guidelines](https://developer.apple.com/app-store/marketing/guidelines/), без изменений.
- [ ] Обложка Reels: кадр кульминации и название крупно (Cinzel / Anton / Clash Display).
- [ ] Подпись к посту: хук, 1 строка о механике, призыв «Ссылка в профиле» и 5–8 хэштегов.
- [ ] Parking Exit публиковать только после одобрения Apple.
