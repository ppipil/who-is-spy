package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// newServer 构造 HTTP mux,行为对齐 server-node/app.ts:
//   - /api/* 路由映射到 GameEngine
//   - 错误分类映射到 400 / 404 / 500 / 502
//   - 生产模式(NODE_ENV=production)托管前端静态产物
func newServer(engine *GameEngine, model GameModel) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":         true,
			"model":      model.Model(),
			"configured": model.IsConfigured(),
		})
	})

	mux.HandleFunc("POST /api/games", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusCreated, engine.CreateGame())
	})

	mux.HandleFunc("GET /api/games/{id}", func(w http.ResponseWriter, r *http.Request) {
		state, err := engine.GetGame(r.PathValue("id"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})

	mux.HandleFunc("POST /api/games/{id}/describe", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Text *string `json:"text"`
		}
		if err := decodeBody(r, &input); err != nil || input.Text == nil {
			writeValidationError(w)
			return
		}
		state, err := engine.SubmitHumanDescription(r.PathValue("id"), *input.Text)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})

	mux.HandleFunc("POST /api/games/{id}/vote", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			TargetID *string `json:"targetId"`
		}
		if err := decodeBody(r, &input); err != nil || input.TargetID == nil || *input.TargetID == "" {
			writeValidationError(w)
			return
		}
		state, err := engine.SubmitHumanVote(r.PathValue("id"), *input.TargetID)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})

	mux.HandleFunc("POST /api/games/{id}/continue", func(w http.ResponseWriter, r *http.Request) {
		state, err := engine.ContinueAsSpectator(r.PathValue("id"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})

	if os.Getenv("NODE_ENV") == "production" {
		serveStatic(mux)
	}

	return mux
}

func serveStatic(mux *http.ServeMux) {
	distDir := filepath.Join("..", "web", "dist")
	fileServer := http.FileServer(http.Dir(distDir))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		candidate := filepath.Join(distDir, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(distDir, "index.html"))
	})
}

func decodeBody(r *http.Request, v any) error {
	defer r.Body.Close()
	data, err := io.ReadAll(io.LimitReader(r.Body, 16*1024))
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return errors.New("empty body")
	}
	return json.Unmarshal(data, v)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeValidationError(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求格式不正确"})
}

func writeError(w http.ResponseWriter, err error) {
	var ruleErr *GameRuleError
	if errors.As(err, &ruleErr) {
		writeJSON(w, ruleErr.Status, map[string]any{"error": ruleErr.Msg})
		return
	}
	var modelErr *ModelError
	if errors.As(err, &modelErr) {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": modelErr.Msg})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "服务暂时出错,请稍后重试"})
}
