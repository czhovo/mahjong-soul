// Native Windows.Graphics.Capture backend; no screen DC or screen-pixel copy.
#define NOMINMAX
#include <windows.h>
#include <roapi.h>
#include <winstring.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi.h>
// WIDL's WinRT boolean specializations require a distinct one-byte C++ type.
// rpcndr.h has already declared the Win32 unsigned-char boolean above.
#define boolean bool
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <windows.foundation.h>
#include <wrl/client.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;
namespace Capture=ABI::Windows::Graphics::Capture;
namespace Direct=ABI::Windows::Graphics::DirectX::Direct3D11;
static thread_local std::string error;
static void check(HRESULT hr,const char* op){if(FAILED(hr)){char code[16];snprintf(code,sizeof(code),"%08lX",(unsigned long)hr);throw std::runtime_error(std::string(op)+" HRESULT=0x"+code);}}
static void closeObject(IUnknown* object){if(!object)return;ComPtr<ABI::Windows::Foundation::IClosable> c;if(SUCCEEDED(object->QueryInterface(IID_PPV_ARGS(&c))))c->Close();}
template<class T> static ComPtr<T> factory(const wchar_t* name){
 HSTRING text=nullptr;check(WindowsCreateString(name,(UINT32)wcslen(name),&text),"WindowsCreateString");
 ComPtr<T> result;HRESULT hr=RoGetActivationFactory(text,IID_PPV_ARGS(&result));WindowsDeleteString(text);check(hr,"RoGetActivationFactory");return result;
}
struct Wgc {
 HWND hwnd;bool ro=false;ABI::Windows::Graphics::SizeInt32 size{};
 ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;ComPtr<Direct::IDirect3DDevice> winDevice;
 ComPtr<Capture::IGraphicsCaptureItem> item;ComPtr<Capture::IDirect3D11CaptureFramePool> pool;ComPtr<Capture::IGraphicsCaptureSession> session;
 ComPtr<ID3D11Texture2D> staging;
 explicit Wgc(HWND window):hwnd(window){
  HRESULT hr=RoInitialize(RO_INIT_MULTITHREADED);if(SUCCEEDED(hr))ro=true;else check(hr,"RoInitialize");
  try{
   check(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context),"D3D11CreateDevice");
   ComPtr<IDXGIDevice> dxgi;check(device.As(&dxgi),"IDXGIDevice");ComPtr<IInspectable> inspectable;
   check(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(),&inspectable),"CreateDirect3D11Device");check(inspectable.As(&winDevice),"IDirect3DDevice");
   auto interop=factory<IGraphicsCaptureItemInterop>(L"Windows.Graphics.Capture.GraphicsCaptureItem");
   check(interop->CreateForWindow(hwnd,IID_PPV_ARGS(&item)),"CreateForWindow");check(item->get_Size(&size),"CaptureItem.Size");
   auto statics=factory<Capture::IDirect3D11CaptureFramePoolStatics2>(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool");
   check(statics->CreateFreeThreaded(winDevice.Get(),ABI::Windows::Graphics::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized,2,size,&pool),"CreateFreeThreaded");
   check(pool->CreateCaptureSession(item.Get(),&session),"CreateCaptureSession");
   ComPtr<Capture::IGraphicsCaptureSession2> cursor;if(SUCCEEDED(session.As(&cursor)))check(cursor->put_IsCursorCaptureEnabled(false),"DisableCursor");
   check(session->StartCapture(),"StartCapture");
  }catch(...){shutdown();throw;}
 }
 void shutdown(){closeObject(session.Get());session.Reset();closeObject(pool.Get());pool.Reset();staging.Reset();item.Reset();winDevice.Reset();context.Reset();device.Reset();if(ro){RoUninitialize();ro=false;}}
 ~Wgc(){shutdown();}
 int grab(unsigned char* out,int capacity,int* width,int* height,int* clientX,int* clientY,int* clientW,int* clientH,long long* stamp,int timeout){
  if(!IsWindow(hwnd))throw std::runtime_error("Bound game window no longer exists; rediscovery required");
  if(IsIconic(hwnd))throw std::runtime_error("Bound game must not be minimized");
  LARGE_INTEGER start,freq;QueryPerformanceCounter(&start);QueryPerformanceFrequency(&freq);
  const long long notBefore=(long long)((long double)start.QuadPart*10000000/freq.QuadPart);
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(timeout);
  ComPtr<Capture::IDirect3D11CaptureFrame> frame;
  while(std::chrono::steady_clock::now()<deadline){
   ComPtr<Capture::IDirect3D11CaptureFrame> next;check(pool->TryGetNextFrame(&next),"TryGetNextFrame");
   if(!next){Sleep(2);continue;}
   ABI::Windows::Foundation::TimeSpan time{};check(next->get_SystemRelativeTime(&time),"Frame.Time");
   if(time.Duration<notBefore){closeObject(next.Get());continue;}
   frame=std::move(next);*stamp=time.Duration;break;
  }
  if(!frame)throw std::runtime_error("WGC fresh frame timeout");
  try{
   ABI::Windows::Graphics::SizeInt32 actual{};check(frame->get_ContentSize(&actual),"Frame.Size");
   if(actual.Width!=size.Width||actual.Height!=size.Height){
    size=actual;closeObject(frame.Get());frame.Reset();staging.Reset();
    check(pool->Recreate(winDevice.Get(),ABI::Windows::Graphics::DirectX::DirectXPixelFormat_B8G8R8A8UIntNormalized,2,size),"FramePool.Recreate");
    throw std::runtime_error("WGC window resized; acquire latest frame");
   }
   *width=size.Width;*height=size.Height;
   if(*width<=0||*height<=0||((long long)*width)*(*height)*4>capacity)throw std::runtime_error("WGC pixel buffer too small");
   ComPtr<Direct::IDirect3DSurface> surface;check(frame->get_Surface(&surface),"Frame.Surface");
   ComPtr<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;check(surface.As(&access),"Surface.Access");
   ComPtr<ID3D11Texture2D> texture;check(access->GetInterface(IID_PPV_ARGS(&texture)),"Surface.Texture");
   if(!staging){D3D11_TEXTURE2D_DESC desc{};texture->GetDesc(&desc);desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=0;desc.MiscFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;check(device->CreateTexture2D(&desc,nullptr,&staging),"Staging.Texture");}
   context->CopyResource(staging.Get(),texture.Get());D3D11_MAPPED_SUBRESOURCE mapped{};check(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped),"Staging.Map");
   for(int y=0;y<*height;y++)std::memcpy(out+y*(*width)*4,(unsigned char*)mapped.pData+y*mapped.RowPitch,(*width)*4);
   context->Unmap(staging.Get(),0);
   // Geometry determines the client offset inside this window texture only.
   // No display pixels are read, and a moved/occluded window remains capturable.
   RECT bounds{},client{};check(DwmGetWindowAttribute(hwnd,DWMWA_EXTENDED_FRAME_BOUNDS,&bounds,sizeof(bounds)),"Window.FrameBounds");
   POINT origin{};if(!GetClientRect(hwnd,&client)||!ClientToScreen(hwnd,&origin))throw std::runtime_error("Cannot locate window client area");
   *clientX=origin.x-bounds.left;*clientY=origin.y-bounds.top;*clientW=client.right;*clientH=client.bottom;
   if(*clientX<0||*clientY<0||*clientX+*clientW>*width||*clientY+*clientH>*height)throw std::runtime_error("WGC client geometry changed; acquire latest frame");
   closeObject(frame.Get());return 1;
  }catch(...){closeObject(frame.Get());throw;}
 }
};
extern "C" {
__declspec(dllexport) const char* wgc_error(){return error.c_str();}
__declspec(dllexport) void* wgc_open(void* hwnd){try{error.clear();return new Wgc((HWND)hwnd);}catch(const std::exception& e){error=e.what();return nullptr;}}
__declspec(dllexport) void wgc_close(void* capture){delete static_cast<Wgc*>(capture);}
__declspec(dllexport) int wgc_grab(void* capture,unsigned char* out,int capacity,int* width,int* height,int* x,int* y,int* cw,int* ch,long long* stamp,int timeout){
 try{error.clear();return static_cast<Wgc*>(capture)->grab(out,capacity,width,height,x,y,cw,ch,stamp,timeout);}catch(const std::exception& e){error=e.what();return 0;}
}
}
