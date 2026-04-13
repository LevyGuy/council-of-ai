import sys

if "--web" in sys.argv:
    sys.argv.remove("--web")
    from council.server import main
else:
    from council.main import main

main()
