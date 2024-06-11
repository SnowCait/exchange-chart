/// <reference lib="deno.unstable" />

import { type Handlers } from "$fresh/server.ts";
import { chart } from "$fresh_charts/core.ts";
import { ChartJs } from "$fresh_charts/deps.ts";
import { ChartColors, transparentize } from "$fresh_charts/utils.ts";
import { delay } from "$std/async/delay.ts";
import { render } from "resvg_wasm";

const kv = await Deno.openKv();

const supportedPairs = [
  "btc_jpy",
  "etc_jpy",
  "lsk_jpy",
  "mona_jpy",
  "plt_jpy",
  "fnct_jpy",
  "dai_jpy",
  "wbtc_jpy",
];

console.log("[env]", Deno.env.toObject());

export const handler: Handlers = {
  async GET(_, { params, renderNotFound }) {
    console.log("[chart]", params);
    const { pair, date } = params;
    const today = new Date(date.replace(/\.(png|svg)$/, ""));
    today.setHours(today.getHours() - 9);
    if (!supportedPairs.includes(pair) || Number.isNaN(today.getTime())) {
      console.error("[invalid params]", params);
      return renderNotFound();
    }

    const dates = Array.from({ length: 31 }).map((_, i) => {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      return date;
    });

    const chunkedEntries = await Promise.all(
      chunk(dates, 10).map(async (chunkedDates) =>
        await kv.getMany(
          chunkedDates.map((date) => [pair, date.toISOString()]),
        )
      ),
    );

    console.log("[cache]", chunkedEntries);

    const entries = chunkedEntries.flatMap((entries) =>
      entries.filter(({ value }) => value !== null)
    );

    const data = new Map<string, string>(
      entries.map((
        { key, value },
      ) => {
        const [, time] = key as [string, string];
        const { rate } = value as { rate: string };
        return [time, rate];
      }),
    );
    console.log("[cache data]", data);

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const time = date.toISOString();

      // From cache
      if (data.has(time)) {
        continue;
      }

      // From API
      const url =
        `https://coincheck.com/exchange/rates/search?pair=${pair}&time=${time}`;
      const response = await fetch(url);
      const { rate } = await response.json();
      console.log("[api]", pair, time, rate);

      // To cache
      if (rate !== undefined) {
        await kv.set([pair, time], { rate });
      }

      data.set(time, rate);

      if (i % 5 === 4) {
        await delay(500);
      }
    }

    const svg = chart({
      type: "line",
      data: {
        labels: [...data.keys()].reverse().map((time) => {
          const date = new Date(time);
          return `${date.getMonth() + 1}/${date.getDate()}`;
        }),
        datasets: [
          {
            label: `${pair} (${today.toLocaleDateString("ja")})`,
            data: [...data].reverse().map(([, rate]) => Number(rate)),
            borderColor: ChartColors.Blue,
            backgroundColor: transparentize(ChartColors.Blue, 0.5),
            borderWidth: 1,
          },
        ],
      },
      options: {
        scales: {
          x: {
            ticks: {
              maxRotation: 0,
            },
          },
        },
      },
      plugins: [{
        id: "backgroundColor",
        beforeDraw: (chart: ChartJs.Chart) => {
          const { ctx } = chart;
          ctx.save();
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, chart.width, chart.height);
          ctx.restore();
        },
      }],
    });

    if (date.endsWith(".svg")) {
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
        },
      });
    } else {
      const png = await render(svg);
      return new Response(png, {
        headers: {
          "Content-Type": "image/png",
        },
      });
    }
  },
};

function chunk<T>(array: T[], size: number): T[][] {
  return Array.from(
    { length: Math.ceil(array.length / size) },
    (_, i) => array.slice(i * size, i * size + size),
  );
}
