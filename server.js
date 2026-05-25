/**
 * PayPal JS SDK v6 — Express サーバー
 *
 * エンドポイント:
 *   POST /api/orders          注文を作成して orderId を返す
 *   POST /api/orders/:id/capture  注文をキャプチャ（決済確定）
 *
 * 使い方:
 *   1. npm install express node-fetch dotenv cors
 *   2. .env に PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET を設定
 *   3. node server.js
 */

import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(express.json());
app.use(cors({ origin: "http://localhost:3000" })); // フロントエンドのオリジンに合わせて変更

// ----------------------------------------------------------------
// 設定
// ----------------------------------------------------------------
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PORT = 8080,
  NODE_ENV = "development",
} = process.env;

// サンドボックス or 本番を自動選択
const PAYPAL_API_BASE =
  NODE_ENV === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

// ----------------------------------------------------------------
// PayPal OAuth — アクセストークンを取得
// トークンをメモリキャッシュして期限が切れたら再取得
// ----------------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken; // まだ有効なトークンを再利用
  }

  const credentials = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal 認証失敗: ${res.status} ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log("[Auth] アクセストークンを取得しました（有効期限:", data.expires_in, "秒）");
  return cachedToken;
}

// ----------------------------------------------------------------
// POST /api/orders — 注文作成
// ----------------------------------------------------------------
app.post("/api/orders", async (req, res) => {
  try {
    const {
      amount = "49.99",
      currency = "USD",
      items = [],
    } = req.body;

    const token = await getAccessToken();

    // Orders v2 API に注文を作成
    const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // 冪等性キー: 同じリクエストが重複実行されるのを防ぐ
        "PayPal-Request-Id": `order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: currency,
              value: amount,
              // 明細（任意）
              ...(items.length > 0 && {
                breakdown: {
                  item_total: { currency_code: currency, value: amount },
                  shipping:   { currency_code: currency, value: "0.00" },
                  tax_total:  { currency_code: currency, value: "0.00" },
                },
              }),
            },
            // 明細行（任意）
            ...(items.length > 0 && {
              items: items.map((item) => ({
                name:        item.name,
                quantity:    String(item.quantity ?? 1),
                unit_amount: { currency_code: currency, value: item.price },
                category:    "PHYSICAL_GOODS",
              })),
            }),
          },
        ],
        // 支払い完了後のリダイレクト URL（ポップアップ不使用時に利用）
        application_context: {
          return_url: `http://localhost:${PORT}/success`,
          cancel_url: `http://localhost:${PORT}/cancel`,
          brand_name: "My Store",
          user_action: "PAY_NOW",
        },
      }),
    });

    const order = await response.json();

    if (!response.ok) {
      console.error("[createOrder] PayPal エラー:", order);
      return res.status(response.status).json({
        error: order.message ?? "注文の作成に失敗しました",
        details: order.details ?? [],
      });
    }

    console.log("[createOrder] 注文作成成功:", order.id);

    // フロントエンドに orderId を返す（v6 SDK が要求する形式）
    res.json({ id: order.id });

  } catch (err) {
    console.error("[createOrder] サーバーエラー:", err);
    res.status(500).json({ error: "内部サーバーエラー" });
  }
});

// ----------------------------------------------------------------
// POST /api/orders/:id/capture — 注文キャプチャ（決済確定）
// ----------------------------------------------------------------
app.post("/api/orders/:id/capture", async (req, res) => {
  const { id: orderId } = req.params;

  try {
    const token = await getAccessToken();

    const response = await fetch(
      `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": `capture-${orderId}`,
        },
      }
    );

    const captureData = await response.json();

    if (!response.ok) {
      console.error("[captureOrder] PayPal エラー:", captureData);
      return res.status(response.status).json({
        error: captureData.message ?? "キャプチャに失敗しました",
        details: captureData.details ?? [],
      });
    }

    // キャプチャ結果の検証
    const captureStatus = captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (captureStatus !== "COMPLETED") {
      console.warn("[captureOrder] キャプチャステータスが COMPLETED ではありません:", captureStatus);
    }

    console.log("[captureOrder] キャプチャ完了:", orderId, "→", captureStatus);

    // ここで DB への注文保存などのビジネスロジックを追加
    // await saveOrderToDatabase({ orderId, captureData });

    res.json(captureData);

  } catch (err) {
    console.error("[captureOrder] サーバーエラー:", err);
    res.status(500).json({ error: "内部サーバーエラー" });
  }
});

// ----------------------------------------------------------------
// ヘルスチェック
// ----------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    env: NODE_ENV,
    paypalApi: PAYPAL_API_BASE,
  });
});

// ----------------------------------------------------------------
// 静的ファイル配信（フロントエンドと同居させる場合）
// ----------------------------------------------------------------
// app.use(express.static("public"));

// ----------------------------------------------------------------
// サーバー起動
// ----------------------------------------------------------------
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error(
    "❌ 環境変数が未設定です。.env ファイルに PAYPAL_CLIENT_ID と PAYPAL_CLIENT_SECRET を設定してください。"
  );
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT}`);
  console.log(`   環境: ${NODE_ENV}`);
  console.log(`   PayPal API: ${PAYPAL_API_BASE}`);
});
