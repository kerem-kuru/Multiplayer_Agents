#!/usr/bin/env bash
#
# Oda dosyalarina container UZERINDEN erismek icin yardimcilar.
#
# Hafta 7, Karar 2: /room artik host'ta bir klasor DEGIL, named volume.
# Host oda dosyalarini goremiyor; her inceleme "docker exec" ile yapilir.
# Hafta 1-6 kapilarinda "rooms-data/<id>/..." okuyan her satir buraya tasinir.
#
# Kullanim:
#   source scripts/lib/room-exec.sh
#   room_exec <odaId> <kullanici> <komut...>
#   room_cat  <odaId> <kullanici> <yol>
#   room_stat <odaId> <yol...>
#   room_cp_in <odaId> <hostYolu> <containerYolu> <sahip>

export MSYS_NO_PATHCONV=1

# Oda id -> container adi. packages/core/src/docker/container.ts ile ayni kural:
# tirelersiz ilk 8 karakter.
room_container() {
  local id="${1//-/}"
  echo "agent-rooms-room-${id:0:8}"
}

# Komutu container icinde belirtilen kullaniciyla kosar.
#
# Kullanici ISIMLE veriliyor: Docker ismi cozdugunde /etc/group'taki EK
# GRUPLARI da yukler. uid verilseydi agent rooms-contracts grubunu almaz ve
# izin matrisi yanlis sonuc verirdi.
room_exec() {
  local id="$1" user="$2"; shift 2
  docker exec -u "$user" "$(room_container "$id")" "$@" 2>&1
}

# Kabuk uzerinden kosar (yonlendirme, &&, * icin).
room_sh() {
  local id="$1" user="$2" cmd="$3"
  docker exec -u "$user" "$(room_container "$id")" sh -c "$cmd" 2>&1
}

room_cat() {
  local id="$1" user="$2" path="$3"
  room_exec "$id" "$user" cat "$path"
}

# stat: "<yol> <sahip> <grup> <mod>" satirlari. Izin matrisinin okudugu bicim.
room_stat() {
  local id="$1"; shift
  room_exec "$id" root stat -c "%n %U %G %a" "$@"
}

# Host'tan container'a kopyalar VE sahipligini duzeltir.
#
# "docker cp" ile giren dosyalarin sahibi ROOT olur; duzeltilmezse agent
# kendi worktree'sindeki dosyayi degistiremez ve kapi ürünü haksiz yere
# suclardi.
room_cp_in() {
  local id="$1" src="$2" dest="$3" owner="$4"
  local c; c="$(room_container "$id")"
  docker cp "$src" "$c:$dest" >/dev/null || return 1
  docker exec -u root "$c" chown -R "$owner" "$dest"
}

# Bir islemin IZIN HATASI ile dusmesini bekler.
#
# Cikis kodu 0 ise basarisiz: yazma gerceklesmis demektir.
room_denied() {
  local id="$1" user="$2" cmd="$3"
  local out; out="$(room_sh "$id" "$user" "$cmd")"
  if [ $? -eq 0 ]; then
    echo "IZIN VERILDI (beklenmiyordu): $out"
    return 1
  fi
  case "$out" in
    *"Permission denied"*|*"permission denied"*|*"Izin verilmedi"*) return 0 ;;
    *) echo "basarisiz ama izin hatasi degil: $out"; return 1 ;;
  esac
}
