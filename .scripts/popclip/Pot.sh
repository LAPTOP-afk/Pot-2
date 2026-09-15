curl -Lsd "$POPCLIP_TEXT" "127.0.0.1:60828"

if [ $? -eq 0 ]; then
    exit 0
else
    open -g -a Pot2
    sleep 2
    curl -Lsd "$POPCLIP_TEXT" "127.0.0.1:60828/translate"
fi