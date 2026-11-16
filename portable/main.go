// Ejecutable portable: sirve el sitio ya compilado (incrustado en el binario) en un
// puerto local y lo abre en el navegador. El relieve y los mapas base se siguen pidiendo
// a IDECA, así que hace falta conexión a internet.
//
// Antes de compilar hay que copiar el resultado de "npm run build" a portable/dist.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
)

//go:embed all:dist
var site embed.FS

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Println("No se pudo abrir el navegador; abre la dirección a mano.")
	}
}

func main() {
	port := flag.Int("puerto", 5174, "puerto local; si está ocupado se usa uno libre")
	noBrowser := flag.Bool("sin-navegador", false, "no abrir el navegador al iniciar")
	flag.Parse()

	// Tipos que el registro del sistema puede no conocer.
	mime.AddExtensionType(".geojson", "application/geo+json")
	mime.AddExtensionType(".pbf", "application/x-protobuf")
	mime.AddExtensionType(".bin", "application/octet-stream")
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".svg", "image/svg+xml")

	root, err := fs.Sub(site, "dist")
	if err != nil {
		log.Fatal(err)
	}

	// Solo escucha en esta máquina.
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatal(err)
		}
	}
	url := fmt.Sprintf("http://localhost:%d/", listener.Addr().(*net.TCPAddr).Port)

	fmt.Println("Ciclorrutas de Bogotá")
	fmt.Println("  Abierto en " + url)
	fmt.Println("  Necesita internet para el relieve y los mapas base de IDECA.")
	fmt.Println("  Cierra esta ventana o pulsa Ctrl+C para terminar.")
	if !*noBrowser {
		openBrowser(url)
	}

	go func() {
		if err := http.Serve(listener, http.FileServer(http.FS(root))); err != nil {
			log.Fatal(err)
		}
	}()
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	<-interrupt
}
