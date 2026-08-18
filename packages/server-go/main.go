package main

import (
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
)

// resolveModel 选择运行时模型来源(与 server-node 一致):
//   GAME_MODEL=fake  确定性替身,无需密钥(契约测试 / 本地冒烟)
//   否则             真实 OpenAI-compatible 调用,需要 DEEPSEEK_API_KEY
func resolveModel() GameModel {
	if strings.ToLower(os.Getenv("GAME_MODEL")) == "fake" {
		return &FakeGameModel{}
	}
	return NewDeepSeekClient()
}

func main() {
	loadDotEnv()

	model := resolveModel()
	engine := NewGameEngine(model, rand.Float64)
	handler := newServer(engine, model)

	port := envOr("PORT", "8787")
	log.Printf("潜词局 (Go) server listening on http://localhost:%s", port)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal(err)
	}
}

// loadDotEnv 读取仓库根目录的 .env(若存在),仅填充尚未设置的变量。
// 保持零依赖,不覆盖已有环境变量。
func loadDotEnv() {
	for _, path := range []string{".env", "../../.env"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, value, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			key = strings.TrimSpace(key)
			value = strings.Trim(strings.TrimSpace(value), `"'`)
			if _, exists := os.LookupEnv(key); !exists {
				_ = os.Setenv(key, value)
			}
		}
		return
	}
}
