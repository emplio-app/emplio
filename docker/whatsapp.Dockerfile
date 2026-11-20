# People's linked WhatsApp accounts (whatsapp/, Go with whatsmeow). Only Emplio talks to it, with WHATSAPP_TOKEN.
FROM golang:1.27 AS build
WORKDIR /src
COPY whatsapp/go.mod whatsapp/go.sum ./
RUN go mod download
COPY whatsapp/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /whatsapp .

FROM gcr.io/distroless/static-debian12
COPY --from=build /whatsapp /whatsapp
ENV DATA_DIR=/data
CMD ["/whatsapp"]
