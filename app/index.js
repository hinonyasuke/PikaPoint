const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const cron = require("node-cron");
const { EmbedBuilder } = require("discord.js");
const kujiLocks = new Map();

// --------------------
// Webサーバー（Koyeb + UptimeRobot 用）
// --------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.status(200).send("Bot is alive!");
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const DATA_FILE = "./kuji_data.json";

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return {
        kujiHistory: {},
        points: {},
        lastMonthlyReset: null,
        lastMonthlyRanking: {},
        totalPoints: {},
      };
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    if (!raw.trim()) {
      throw new Error("Empty JSON");
    }

    return JSON.parse(raw);
  } catch (e) {
    console.error("⚠ JSON load failed, reinitializing:", e.message);
    return {
      kujiHistory: {},
      points: {},
      lastMonthlyReset: null,
      lastMonthlyRanking: {},
      totalPoints: {},
    };
  }
}

// --------------------
// データ管理
// --------------------
let data = loadData();
for (const g in data.kujiHistory) {
  for (const u in data.kujiHistory[g]) {
    const v = data.kujiHistory[g][u];
    if (typeof v === "string") {
      data.kujiHistory[g][u] = new Date(v).getTime();
    }
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("❌ saveData failed:", e);
  }
}

//ランキング生成関数
async function createRankingText(guild, points) {
  const ranking = Object.entries(points)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (ranking.length === 0) return "データがありません。";

  let text = "🏆 **先月のくじポイントランキング** 🏆\n";
  for (let i = 0; i < ranking.length; i++) {
    const user = await guild.client.users.fetch(ranking[i][0]);
    text += `${i + 1}位：${user.username}（${ranking[i][1]}pt）\n`;
  }
  return text;
}

// --------------------
// くじ設定
// --------------------
const kujiList = [
  {
    name: "ウルトラ大吉",
    point: 50,
    weight: 1,
    items: ["金のりんご", "伝説の剣"],
  },
  {
    name: "超大吉",
    point: 30,
    weight: 3,
    items: ["高級腕時計", "ブランド財布"],
  },
  { name: "大吉", point: 10, weight: 6, items: ["スニーカー", "イヤホン"] },
  { name: "中吉", point: 5, weight: 20, items: ["本", "文房具"] },
  { name: "小吉", point: 3, weight: 35, items: ["傘", "ハンカチ"] },
  { name: "凶", point: -5, weight: 25, items: ["石ころ"] },
  { name: "大凶", point: -10, weight: 7, items: ["割れた鏡"] },
  { name: "超大凶", point: -15, weight: 3, items: ["呪われた人形"] },
];
//重み付き抽選
function drawKuji() {
  const totalWeight = kujiList.reduce((sum, k) => sum + k.weight, 0);
  let rand = Math.random() * totalWeight;

  for (const kuji of kujiList) {
    rand -= kuji.weight;
    if (rand <= 0) return kuji;
  }
}

// --------------------
// 時間関連（JST）(表示用)
// --------------------
function nowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// --------------------
// 毎日0時・12時リセット
// --------------------
cron.schedule(
  "1 0 1 * *",
  async () => {
    for (const guild of client.guilds.cache.values()) {
      const guildId = guild.id;
      const points = data.points[guildId] || {};

      const rankingText = await createRankingText(guild, points);

      // 最初に見つかったテキストチャンネルへ送信
      const channel = guild.channels.cache.find(
        (ch) =>
          ch.isTextBased() &&
          ch.permissionsFor(guild.members.me).has("SendMessages"),
      );

      if (channel) {
        channel.send(rankingText);
      }
    }

    // ポイントリセット
    data.points = {};
    saveData();
  },
  { timezone: "Asia/Tokyo" },
);

// --------------------
// 月初ポイントリセット
// --------------------
cron.schedule(
  "0 0 1 * *",
  () => {
    data.points = {};
    data.lastMonthlyReset = nowJST().toISOString();
    saveData();
  },
  { timezone: "Asia/Tokyo" },
);

//!kujirate 確率表表示
function getKujiRates() {
  const total = kujiList.reduce((sum, k) => sum + k.weight, 0);
  return kujiList.map((k) => ({
    name: k.name,
    rate: ((k.weight / total) * 100).toFixed(1),
    point: k.point,
  }));
}

//順位計算用の共通関数
function getUserRank(pointsObj, userId) {
  const sorted = Object.entries(pointsObj).sort((a, b) => b[1] - a[1]);

  const index = sorted.findIndex(([id]) => id === userId);
  if (index === -1) return null;

  return {
    rank: index + 1,
    point: sorted[index][1],
    total: sorted.length,
  };
}

// --------------------
// メッセージ処理
// --------------------
client.on("messageCreate", async (message) => {
  if (!message.guild) return;

  if (message.author.bot) return;
  const guildId = message.guild.id;
  const userId = message.author.id;

  if (!data.kujiHistory[guildId]) data.kujiHistory[guildId] = {};
  if (!data.points[guildId]) data.points[guildId] = {};

  // --------------------
  // !kuji
  // --------------------
  if (message.content === "!kuji") {
    const key = `${guildId}:${userId}`;

    // 🔒 ロック中なら即拒否
    if (kujiLocks.has(key)) {
      return message.reply("⏳ 処理中です。少し待ってから再度実行してください");
    }

    kujiLocks.set(key, true);

    try {
      const last = data.kujiHistory[guildId][userId];
      const cooldown = 12 * 60 * 60 * 1000;

      if (last) {
        const diff = cooldown - (Date.now() - last);

        if (diff > 0) {
          const h = Math.floor(diff / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          return message.reply(`⏳ クールタイム中です。あと ${h}時間${m}分`);
        }
      }

      // ⭐ クールタイムを「先に」書き込む（重要）
      data.kujiHistory[guildId][userId] = Date.now();

      const result = drawKuji();
      const item =
        result.items[Math.floor(Math.random() * result.items.length)];

      data.points[guildId][userId] =
        (data.points[guildId][userId] || 0) + result.point;

      if (!data.totalPoints[guildId]) data.totalPoints[guildId] = {};
      data.totalPoints[guildId][userId] =
        (data.totalPoints[guildId][userId] || 0) + result.point;

      saveData();

      return message.reply(
        `🎯 **${result.name}**\n🎁 ${item}\n⭐ ${result.point}pt`,
      );
    } finally {
      // 🔓 必ずロック解除
      kujiLocks.delete(key);
    }
  }

  // --------------------
  // !kujipoint
  // --------------------
  if (message.content === "!kujipoint") {
    const guild = message.guild;
    const channel = message.channel;
    const points = data.points[guild.id] || {};

    const ranking = Object.entries(points)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (ranking.length === 0) {
      return message.reply("まだポイントデータがありません。");
    }

    const embed = new EmbedBuilder()
      .setTitle("🏆 今月のくじポイントランキング")
      .setColor(0xffa500)
      .setTimestamp();

    for (let i = 0; i < ranking.length; i++) {
      const user = await client.users.fetch(ranking[i][0]);
      const medal = ["🥇", "🥈", "🥉"][i] || `${i + 1}位`;
      embed.addFields({
        name: `${medal} ${user.username}`,
        value: `${ranking[i][1]} pt`,
        inline: false,
      });
    }

    return channel.send({ embeds: [embed] });
  }

  // --------------------
  // !kujiadd/!kujiset
  // --------------------
  if (
    message.content.startsWith("!kujiadd") ||
    message.content.startsWith("!kujiset")
  ) {
    if (!message.member.permissions.has("Administrator")) {
      return message.reply("❌ 管理者のみ使用可能です");
    }

    const args = message.content.split(/\s+/);
    const target = message.mentions.users.first();
    const value = parseInt(args[2], 10);

    if (!target || isNaN(value)) {
      return message.reply(
        "使い方：\n`!kujiadd @user 数値`\n`!kujiset @user 数値`",
      );
    }

    if (!data.points[guildId][target.id]) {
      data.points[guildId][target.id] = 0;
    }

    if (message.content.startsWith("!kujiadd")) {
      data.points[guildId][target.id] += value;
      message.reply(
        `✅ ${target.username} に ${value}pt 追加しました（現在 ${data.points[guildId][target.id]}pt）`,
      );
    }

    if (message.content.startsWith("!kujiset")) {
      data.points[guildId][target.id] = value;
      message.reply(
        `✅ ${target.username} のポイントを ${value}pt に設定しました`,
      );
    }

    saveData();
  }

  //!kujirate
  if (message.content === "!kujirate") {
    const total = kujiList.reduce((sum, k) => sum + k.weight, 0);

    const embed = new EmbedBuilder()
      .setTitle("🎯 くじ確率表")
      .setColor(0x00bfff)
      .setFooter({ text: "確率は重み付け抽選に基づきます" });

    for (const k of kujiList) {
      const rate = ((k.weight / total) * 100).toFixed(1);
      embed.addFields({
        name: k.name,
        value: `確率：${rate}%\nポイント：${k.point}pt`,
        inline: true,
      });
    }

    return message.reply({ embeds: [embed] });
  }
  //!kujitotal
  if (message.content === "!kujitotal") {
    const guildId = message.guild.id;
    const totals = data.totalPoints[guildId] || {};

    const ranking = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (ranking.length === 0) {
      return message.reply("まだ累計ポイントデータがありません。");
    }

    const embed = new EmbedBuilder()
      .setTitle("📊 累計くじポイントランキング")
      .setColor(0x8a2be2)
      .setTimestamp();

    for (let i = 0; i < ranking.length; i++) {
      const user = await client.users.fetch(ranking[i][0]);
      const medal = ["🥇", "🥈", "🥉"][i] || `${i + 1}位`;
      embed.addFields({
        name: `${medal} ${user.username}`,
        value: `${ranking[i][1]} pt`,
        inline: false,
      });
    }

    return message.reply({ embeds: [embed] });
  }

  //!kujirank
  if (message.content.startsWith("!kujirank")) {
    const guildId = message.guild.id;

    // メンションがあればそのユーザー、なければ自分
    const targetUser = message.mentions.users.first() || message.author;

    const userId = targetUser.id;

    const monthly = getUserRank(data.points[guildId] || {}, userId);
    const total = getUserRank(data.totalPoints[guildId] || {}, userId);

    if (!monthly && !total) {
      return message.reply("まだくじを引いていません。");
    }

    const embed = new EmbedBuilder()
      .setTitle(`📌 ${targetUser.username} のくじ順位`)
      .setColor(0x00fa9a)
      .setThumbnail(targetUser.displayAvatarURL())
      .setTimestamp();

    // 月間
    if (monthly) {
      embed.addFields({
        name: "🗓 月間順位",
        value:
          `順位：**${monthly.rank}位 / ${monthly.total}人**\n` +
          `ポイント：**${monthly.point}pt**`,
        inline: false,
      });
    } else {
      embed.addFields({
        name: "🗓 月間順位",
        value: "今月はまだポイントがありません。",
        inline: false,
      });
    }

    // 累計
    if (total) {
      embed.addFields({
        name: "📊 累計順位",
        value:
          `順位：**${total.rank}位 / ${total.total}人**\n` +
          `ポイント：**${total.point}pt**`,
        inline: false,
      });
    } else {
      embed.addFields({
        name: "📊 累計順位",
        value: "累計ポイントがありません。",
        inline: false,
      });
    }

    return message.reply({ embeds: [embed] });
  }
});

// --------------------
if (global.__BOT_STARTED__) {
  console.log("Bot already started");
  process.exit(0);
}
global.__BOT_STARTED__ = true;

client.login(process.env.DISCORD_TOKEN);

process.on("SIGINT", () => {
  console.log("Bot shutting down...");
  saveData();
  client.destroy();
  process.exit(0);
});

