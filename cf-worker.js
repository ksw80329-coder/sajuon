const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return json({ status: "ok", key: !!env.ANTHROPIC_API_KEY });
    if (url.pathname === "/ping") return json({ ok: true });

    // ── 토스페이 결제창 생성 ────────────────────────────
    if (req.method === "POST" && url.pathname === "/toss-pay-create") {
      try {
        const { orderId, amount, orderName, successUrl, failUrl } = await req.json();
        if (!orderId || !amount || !orderName) {
          return json({ success: false, message: "orderId, amount, orderName 필수" }, 400);
        }
        if (!env.TOSS_SECRET_KEY) {
          return json({ success: false, message: "토스페이 키 미설정" }, 500);
        }

        const tossRes = await fetch("https://pay.toss.im/api/v2/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderNo: orderId,
            amount,
            amountTaxFree: 0,
            productDesc: orderName,
            apiKey: env.TOSS_SECRET_KEY,
            autoExecute: true,
            retUrl: successUrl,
            retCancelUrl: failUrl,
          }),
        });

        const data = await tossRes.json();
        if (data.code !== 0 || !data.checkoutPage) {
          console.error("토스페이 생성 실패:", JSON.stringify(data));
          return json({ success: false, message: data.msg || "결제창 생성 실패" }, 400);
        }

        return json({ success: true, checkoutPage: data.checkoutPage, payToken: data.payToken });
      } catch (e) {
        console.error("토스페이 생성 오류:", String(e));
        return json({ success: false, message: "서버 오류" }, 500);
      }
    }

    // ── 토스페이 결제 승인 ───────────────────────────────
    if (req.method === "POST" && url.pathname === "/toss-pay-confirm") {
      try {
        const { payToken, orderId, amount } = await req.json();
        if (!payToken || !orderId || !amount) {
          return json({ success: false, message: "payToken, orderId, amount 필수" }, 400);
        }

        const tossRes = await fetch("https://pay.toss.im/api/v2/payments/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payToken,
            apiKey: env.TOSS_SECRET_KEY,
          }),
        });

        const data = await tossRes.json();
        if (!tossRes.ok || data.code !== "0000") {
          console.error("토스페이 승인 실패:", JSON.stringify(data));
          return json({ success: false, message: data.msg || "결제 승인 실패" }, 400);
        }

        // 금액 검증
        if (data.amount !== amount) {
          return json({ success: false, message: "결제 금액 불일치" }, 400);
        }

        return json({ success: true, data });
      } catch (e) {
        console.error("토스페이 승인 오류:", String(e));
        return json({ success: false, message: "서버 오류" }, 500);
      }
    }

    // ── 포트원 결제 검증 (카카오페이용) ─────────────────
    if (req.method === "POST" && url.pathname === "/verify") {
      try {
        const { imp_uid, merchant_uid, amount } = await req.json();
        if (!imp_uid || !amount) {
          return json({ success: false, message: "imp_uid, amount 필수" }, 400);
        }

        if (!env.PORTONE_API_SECRET) {
          return json({ success: true, message: "검증 스킵(키 없음)" });
        }

        // 포트원 액세스 토큰 발급
        const tokenRes = await fetch("https://api.iamport.kr/users/getToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imp_key: env.PORTONE_IMP_KEY,
            imp_secret: env.PORTONE_API_SECRET,
          }),
        });
        const tokenData = await tokenRes.json();
        const accessToken = tokenData?.response?.access_token;
        if (!accessToken) throw new Error("토큰 발급 실패");

        // 결제 정보 조회
        const payRes = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
          headers: { Authorization: accessToken },
        });
        const payData = await payRes.json();
        const payment = payData?.response;

        if (!payment || payment.status !== "paid") {
          return json({ success: false, message: "결제 미완료" });
        }
        if (payment.amount !== amount) {
          return json({ success: false, message: "결제 금액 불일치" });
        }

        return json({ success: true });
      } catch (e) {
        console.error("포트원 검증 오류:", String(e));
        return json({ success: true, message: "검증 서버 오류 - 결제 신뢰" });
      }
    }

    if (url.pathname === "/test-model") {
      const model = url.searchParams.get("model") || "claude-haiku-4-5-20251001";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
      });
      const data = await res.json();
      return json({ model, status: res.status, ok: res.ok, response: data });
    }

    if (req.method === "POST" && url.pathname === "/q") {
      try {
        const raw = await req.text();
        let payload;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.b) {
            const bin = atob(parsed.b);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            payload = JSON.parse(new TextDecoder().decode(bytes));
          } else {
            payload = parsed;
          }
        } catch {
          return json({ error: "Invalid request body" }, 400);
        }

        if (payload?.ping) return json({ ok: true });
        if (!env.ANTHROPIC_API_KEY) return json({ error: "API key not configured" }, 500);

        // 스트리밍
        if (payload.stream === true) {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();

          const response = new Response(readable, {
            status: 200,
            headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
          });

          (async () => {
            try {
              const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": env.ANTHROPIC_API_KEY,
                  "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify(payload),
              });

              if (!anthropicRes.ok) {
                const errText = await anthropicRes.text();
                const errMsg = `data: ${JSON.stringify({ type: "error", error: { message: errText } })}\n\n`;
                await writer.write(new TextEncoder().encode(errMsg));
              } else {
                const reader = anthropicRes.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  await writer.write(value);
                }
              }
            } catch (e) {
              console.error("[q] Stream error:", e.message);
            } finally {
              await writer.close();
            }
          })();

          return response;
        }

        // 비스트리밍
        const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(payload),
        });

        if (!anthropicRes.ok) {
          const errBody = await anthropicRes.json().catch(() => ({ error: "Anthropic API error " + anthropicRes.status }));
          return json(errBody, anthropicRes.status);
        }

        const data = await anthropicRes.json();
        return new Response(JSON.stringify(data), {
          status: anthropicRes.status,
          headers: { ...CORS, "Content-Type": "application/json" },
        });

      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    return json({ message: "SajuON AI Server", version: "relay-v7" });
  },
};
