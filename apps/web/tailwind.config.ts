import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#202632",
        mist: "#f3f6f8",
        line: "#d8dee7",
        action: "#2563eb",
        coral: "#e05252",
        jade: "#138a72"
      },
      boxShadow: {
        panel: "0 10px 35px rgba(30, 41, 59, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;

