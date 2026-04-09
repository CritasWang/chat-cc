BINARY  := chatcc
MODULE  := chatcc
GOFILES := $(shell find . -name '*.go' -not -path './vendor/*')

.PHONY: build clean run stop restart

build:
	go build -o $(BINARY) .

clean:
	rm -f $(BINARY)

run: build
	./$(BINARY) console

start: build
	./$(BINARY) start

stop:
	./$(BINARY) stop

restart: build
	./$(BINARY) restart
