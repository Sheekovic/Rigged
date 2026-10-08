"""Generate the original RIGGED bitmap-outline font without external dependencies."""
from pathlib import Path
import struct

patterns = {
'A':'01110 10001 10001 11111 10001 10001 10001','B':'11110 10001 10001 11110 10001 10001 11110',
'C':'01111 10000 10000 10000 10000 10000 01111','D':'11110 10001 10001 10001 10001 10001 11110',
'E':'11111 10000 10000 11110 10000 10000 11111','F':'11111 10000 10000 11110 10000 10000 10000',
'G':'01111 10000 10000 10111 10001 10001 01111','H':'10001 10001 10001 11111 10001 10001 10001',
'I':'11111 00100 00100 00100 00100 00100 11111','J':'00111 00010 00010 00010 10010 10010 01100',
'K':'10001 10010 10100 11000 10100 10010 10001','L':'10000 10000 10000 10000 10000 10000 11111',
'M':'10001 11011 10101 10101 10001 10001 10001','N':'10001 11001 10101 10011 10001 10001 10001',
'O':'01110 10001 10001 10001 10001 10001 01110','P':'11110 10001 10001 11110 10000 10000 10000',
'Q':'01110 10001 10001 10001 10101 10010 01101','R':'11110 10001 10001 11110 10100 10010 10001',
'S':'01111 10000 10000 01110 00001 00001 11110','T':'11111 00100 00100 00100 00100 00100 00100',
'U':'10001 10001 10001 10001 10001 10001 01110','V':'10001 10001 10001 10001 10001 01010 00100',
'W':'10001 10001 10001 10101 10101 10101 01010','X':'10001 10001 01010 00100 01010 10001 10001',
'Y':'10001 10001 01010 00100 00100 00100 00100','Z':'11111 00001 00010 00100 01000 10000 11111',
'0':'01110 10001 10011 10101 11001 10001 01110','1':'00100 01100 00100 00100 00100 00100 01110',
'2':'01110 10001 00001 00010 00100 01000 11111','3':'11110 00001 00001 01110 00001 00001 11110',
'4':'00010 00110 01010 10010 11111 00010 00010','5':'11111 10000 10000 11110 00001 00001 11110',
'6':'01110 10000 10000 11110 10001 10001 01110','7':'11111 00001 00010 00100 01000 01000 01000',
'8':'01110 10001 10001 01110 10001 10001 01110','9':'01110 10001 10001 01111 00001 00001 01110',
'$':'00100 01111 10100 01110 00101 11110 00100','%':'11001 11010 00100 00100 01000 10110 00110',
'.':'00000 00000 00000 00000 00000 00110 00110',',':'00000 00000 00000 00000 00110 00100 01000',
':':'00000 00110 00110 00000 00110 00110 00000','-':'00000 00000 00000 11111 00000 00000 00000',
'+':'00000 00100 00100 11111 00100 00100 00000','/':'00001 00010 00010 00100 01000 01000 10000',
'[':'01110 01000 01000 01000 01000 01000 01110',']':'01110 00010 00010 00010 00010 00010 01110',
'(':'00010 00100 01000 01000 01000 00100 00010',')':'01000 00100 00010 00010 00010 00100 01000',
'!':'00100 00100 00100 00100 00100 00000 00100','?':'01110 10001 00001 00010 00100 00000 00100',
'=':'00000 00000 11111 00000 11111 00000 00000','_':'00000 00000 00000 00000 00000 00000 11111',
'<':'00010 00100 01000 10000 01000 00100 00010','>':'01000 00100 00010 00001 00010 00100 01000',
'|':'00100 00100 00100 00100 00100 00100 00100',"'":'00100 00100 00000 00000 00000 00000 00000',
}
pack=struct.pack
def glyph(char):
    rows=patterns.get(char.upper(),'').split()
    rectangles=[]
    for row,bits in enumerate(rows):
        for col,bit in enumerate(bits):
            if bit=='1':
                x,y=col*100,(6-row)*100
                rectangles.append([(x,y),(x,y+80),(x+80,y+80),(x+80,y)])
    if not rectangles:return pack('>hhhhhH',0,0,0,0,0,0)
    points=[p for rectangle in rectangles for p in rectangle]
    data=pack('>hhhhh',len(rectangles),0,0,480,680)
    data+=pack('>'+'H'*len(rectangles),*[i*4+3 for i in range(len(rectangles))])+pack('>H',0)
    data+=bytes([1]*len(points))
    for axis in (0,1):
        previous=0
        for point in points:
            data+=pack('>h',point[axis]-previous);previous=point[axis]
    return data
characters=['?']+[chr(i) for i in range(32,127)]
glyf=bytearray();offsets=[]
for character in characters:
    offsets.append(len(glyf));g=glyph(character);glyf+=g+b'\0'*((-len(g))%4)
offsets.append(len(glyf))
tables={
'glyf':bytes(glyf),'loca':pack('>'+'I'*len(offsets),*offsets),
'hmtx':b''.join(pack('>Hh',600,0) for _ in characters),
'head':pack('>IIIIHHqqhhhhHHhhh',0x10000,0x10000,0,0x5F0F3CF5,0,1000,0,0,0,0,480,680,0,8,2,1,0),
'hhea':pack('>IhhhH',0x10000,800,-200,100,600)+pack('>hhh',0,120,480)+pack('>hhh',1,0,0)+pack('>hhhh',0,0,0,0)+pack('>hH',0,len(characters)),
'maxp':pack('>IH',0x10000,len(characters))+pack('>13H',140,35,0,0,2,0,0,0,0,0,0,0,0),
'post':pack('>IIhhIIIII',0x30000,0,-75,50,1,0,0,0,0),
}
subtable=pack('>7H',4,32,0,4,4,1,0)+pack('>2H',126,65535)+pack('>H',0)+pack('>2H',32,65535)+pack('>2H',65505,1)+pack('>2H',0,0)
tables['cmap']=pack('>HHHHI',0,1,3,1,12)+subtable
names={1:'Rigged Pixel',2:'Regular',3:'RiggedPixel-1.0',4:'Rigged Pixel',5:'Version 1.0',6:'RiggedPixel',0:'Original bitmap-outline font created for RIGGED.'}
records=bytearray();strings=bytearray()
for name_id,value in sorted(names.items()):
    encoded=value.encode('utf-16-be');records+=pack('>6H',3,1,0x409,name_id,len(encoded),len(strings));strings+=encoded
tables['name']=pack('>3H',0,len(names),6+12*len(names))+records+strings
tables['OS/2']=pack('>HhHHH',0,600,400,5,0)+pack('>11h',650,600,0,75,650,600,0,400,50,300,0)+bytes([2,0,5,9,0,0,0,0,0,0])+pack('>4I',1,0,0,0)+b'RGGD'+pack('>3H',64,32,126)+pack('>3h2H',800,-200,100,800,200)
def checksum(data):
    data+=b'\0'*((-len(data))%4)
    return sum(struct.unpack('>'+'I'*(len(data)//4),data))&0xFFFFFFFF
num=len(tables);power=2**(num.bit_length()-1)
header=pack('>I4H',0x10000,num,power*16,power.bit_length()-1,num*16-power*16)
directory=bytearray();body=bytearray();head_offset=0
for tag,data in sorted(tables.items()):
    offset=12+num*16+len(body)
    directory+=pack('>4sIII',tag.encode(),checksum(data),offset,len(data))
    if tag=='head':head_offset=offset
    body+=data+b'\0'*((-len(data))%4)
font=bytearray(header+directory+body)
struct.pack_into('>I',font,head_offset+8,(0xB1B0AFBA-checksum(bytes(font)))&0xFFFFFFFF)
assert checksum(bytes(font))==0xB1B0AFBA
destination=Path(__file__).resolve().parents[1]/'web/fonts/rigged-pixel.ttf'
destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(font)
print(f'Generated {destination.name}: {len(font)} bytes, {len(characters)} glyphs')
